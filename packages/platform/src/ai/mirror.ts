/**
 * Month-spend mirror on redis-cache (S12-01 review, ADR 0008 #6a): the request path (feed-api, `app_public`, no
 * `withSystem`) cannot read `ai_usage_monthly`, so it checks and reserves against this copy instead. One integer per
 * agency and month (micro-USD): the database's settled cost when seeded, plus the request path's open reservations and
 * every cost settled since (both paths adjust it; worker reservations live in the database only). Seeded by the `ai.refreshSpend` job (`SET NX`, `ttlSeconds`), so an expired or evicted
 * key heals within one job; while it is missing the request path refuses (fails closed: `AI_UNAVAILABLE`).
 */

/** The ioredis commands the mirror uses (the cache connection fits). `eval` is Redis EVAL of the fixed Lua scripts below. */
export interface MirrorRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<unknown>;
}

// Returns the spend before the reservation (≥ 0), -1 when unknown (no key), -2 when it would pass the hard cap.
const RESERVE = `
local v = redis.call('GET', KEYS[1])
if not v then return -1 end
local spent = tonumber(v)
if spent + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return -2 end
redis.call('INCRBY', KEYS[1], ARGV[1])
return spent`;

// Adds ARGV[1] (may be negative) only while the key exists: a missing key is reseeded from the database instead.
const ADJUST = `
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('INCRBY', KEYS[1], ARGV[1]) end
return false`;

export type MirrorReserve = { ok: true; spentMicroUsd: number } | { ok: false; reason: 'HARD_CAP' | 'UNKNOWN' };

export interface SpendMirror {
  reserve(agencyId: string, month: string, estimateMicroUsd: number, hardMicroUsd: number): Promise<MirrorReserve>;
  adjust(agencyId: string, month: string, deltaMicroUsd: number): Promise<void>;
  /** Seeds a missing key (never overwrites a live one: its reservations would be lost). */
  seed(agencyId: string, month: string, spentMicroUsd: number): Promise<void>;
}

export function createSpendMirror(options: { redis: MirrorRedis; prefix?: string; ttlSeconds: number }): SpendMirror {
  const prefix = options.prefix ?? 'inl:ai:spend';
  const key = (agencyId: string, month: string) => `${prefix}:${agencyId}:${month}`;
  return {
    async reserve(agencyId, month, estimateMicroUsd, hardMicroUsd) {
      const r = Number(
        await options.redis.eval(RESERVE, 1, key(agencyId, month), Math.ceil(estimateMicroUsd), hardMicroUsd),
      );
      if (r === -1) return { ok: false, reason: 'UNKNOWN' };
      if (r === -2) return { ok: false, reason: 'HARD_CAP' };
      return { ok: true, spentMicroUsd: r };
    },
    async adjust(agencyId, month, deltaMicroUsd) {
      const delta = Math.round(deltaMicroUsd);
      if (delta === 0) return;
      await options.redis.eval(ADJUST, 1, key(agencyId, month), delta);
    },
    async seed(agencyId, month, spentMicroUsd) {
      await options.redis.set(
        key(agencyId, month),
        String(Math.max(0, Math.round(spentMicroUsd))),
        'EX',
        options.ttlSeconds,
        'NX',
      );
    },
  };
}
