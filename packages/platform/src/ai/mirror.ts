/**
 * Month-spend mirror on redis-cache (S12-01 review, ADR 0008 #6a): the request path (feed-api, `app_public`, no
 * `withSystem`) cannot read `ai_usage_monthly`, so it checks and reserves against this copy instead. Three integers
 * (micro-USD) per agency and month:
 *
 * - `base` — the database's spend (`cost + reserved`) when seeded by the `ai.refreshSpend` job (`SET NX`, expires after
 *   `ttlSeconds`, so it heals from the database), plus worker-path costs settled since. While it is missing the request
 *   path refuses (fails closed: `AI_UNAVAILABLE`).
 * - `held` — the request path's open reservations. Never reseeded, so a reseed between a reservation and its settle
 *   cannot lose or double-count it (security review): the settle takes back exactly what it reserved.
 * - `queued` — request-path costs settled but not yet in the database (the `ai.recordUsage` job takes them off once its
 *   row is in). A reseed reads the database, so these would otherwise be missed until recorded.
 *
 * The hard cap is checked against `base + held + queued`. Races only ever over-count (a cost both in a fresh seed and
 * in `queued` for the moment between the job's insert and its decrement), which refuses early rather than overspends.
 * `held` and `queued` expire `LONG_TTL_SECONDS` after their last change (a month and a bit).
 */

/** The ioredis commands the mirror uses (the cache connection fits). `eval` is Redis EVAL of the fixed Lua scripts below. */
export interface MirrorRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<unknown>;
}

const LONG_TTL_SECONDS = 35 * 86_400;

// KEYS: base, held, queued. ARGV: estimate, hard, long ttl. Returns base + queued before the reservation (≥ 0),
// -1 when unknown (no base), -2 when it would pass the hard cap.
const RESERVE = `
local base = redis.call('GET', KEYS[1])
if not base then return -1 end
local held = tonumber(redis.call('GET', KEYS[2]) or '0')
local queued = tonumber(redis.call('GET', KEYS[3]) or '0')
local spent = tonumber(base) + queued
if spent + held + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return -2 end
redis.call('INCRBY', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return spent`;

// Takes ARGV[1] off KEYS[1] (never below 0) and adds ARGV[2] to KEYS[2] (when > 0). ARGV[3]: long ttl.
const MOVE = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local take = math.min(cur, tonumber(ARGV[1]))
if take > 0 then redis.call('DECRBY', KEYS[1], take) end
if tonumber(ARGV[2]) > 0 then
  redis.call('INCRBY', KEYS[2], ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return take`;

// Adds ARGV[1] to the base only while it exists: a missing base is reseeded from the database instead.
const ADJUST = `
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('INCRBY', KEYS[1], ARGV[1]) end
return false`;

export type MirrorReserve = { ok: true; spentMicroUsd: number } | { ok: false; reason: 'HARD_CAP' | 'UNKNOWN' };

export interface SpendMirror {
  /** Holds `estimate` when `base + held + queued + estimate <= hard`. */
  reserve(agencyId: string, month: string, estimateMicroUsd: number, hardMicroUsd: number): Promise<MirrorReserve>;
  /** A request-path call finished: gives back its hold and queues its real cost until the usage row is recorded. */
  settle(agencyId: string, month: string, reservedMicroUsd: number, costMicroUsd: number): Promise<void>;
  /** A request-path hold no call will settle (the provider was never reached). */
  release(agencyId: string, month: string, reservedMicroUsd: number): Promise<void>;
  /** The `ai.recordUsage` job wrote a queued cost to the database: it leaves `queued`. */
  recorded(agencyId: string, month: string, costMicroUsd: number): Promise<void>;
  /** A worker-path cost settled in the database: added to the base while it exists. */
  adjust(agencyId: string, month: string, deltaMicroUsd: number): Promise<void>;
  /** Seeds a missing base (never overwrites a live one). */
  seed(agencyId: string, month: string, spentMicroUsd: number): Promise<void>;
}

export function createSpendMirror(options: { redis: MirrorRedis; prefix?: string; ttlSeconds: number }): SpendMirror {
  const prefix = options.prefix ?? 'inl:ai:spend';
  const keys = (agencyId: string, month: string) => {
    const k = `${prefix}:${agencyId}:${month}`;
    return { base: k, held: `${k}:held`, queued: `${k}:queued` };
  };
  const whole = (n: number) => Math.max(0, Math.round(n));
  return {
    async reserve(agencyId, month, estimateMicroUsd, hardMicroUsd) {
      const k = keys(agencyId, month);
      const r = Number(
        await options.redis.eval(
          RESERVE,
          3,
          k.base,
          k.held,
          k.queued,
          Math.ceil(estimateMicroUsd),
          hardMicroUsd,
          LONG_TTL_SECONDS,
        ),
      );
      if (r === -1) return { ok: false, reason: 'UNKNOWN' };
      if (r === -2) return { ok: false, reason: 'HARD_CAP' };
      return { ok: true, spentMicroUsd: r };
    },
    async settle(agencyId, month, reservedMicroUsd, costMicroUsd) {
      const k = keys(agencyId, month);
      await options.redis.eval(
        MOVE,
        2,
        k.held,
        k.queued,
        whole(reservedMicroUsd),
        whole(costMicroUsd),
        LONG_TTL_SECONDS,
      );
    },
    async release(agencyId, month, reservedMicroUsd) {
      const k = keys(agencyId, month);
      await options.redis.eval(MOVE, 2, k.held, k.queued, whole(reservedMicroUsd), 0, LONG_TTL_SECONDS);
    },
    async recorded(agencyId, month, costMicroUsd) {
      const k = keys(agencyId, month);
      await options.redis.eval(MOVE, 2, k.queued, k.held, whole(costMicroUsd), 0, LONG_TTL_SECONDS);
    },
    async adjust(agencyId, month, deltaMicroUsd) {
      const delta = Math.round(deltaMicroUsd);
      if (delta === 0) return;
      await options.redis.eval(ADJUST, 1, keys(agencyId, month).base, delta);
    },
    async seed(agencyId, month, spentMicroUsd) {
      await options.redis.set(keys(agencyId, month).base, String(whole(spentMicroUsd)), 'EX', options.ttlSeconds, 'NX');
    },
  };
}
