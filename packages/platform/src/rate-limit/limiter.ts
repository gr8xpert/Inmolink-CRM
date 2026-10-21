import type { Redis } from 'ioredis';
import { whenReady } from '../cache/ready';
import { type Clock, clock as processClock } from '../clock';
import { hmacSha256 } from '../crypto/hmac';
import type { Logger } from '../logger';

/** What a limit counts against (PLAN §5.3 #11). */
export type RateScope = 'ip' | 'user' | 'key' | 'tenant' | 'email';

export interface RateLimitRule {
  /** Stable name, part of the Redis key (`auth.login`, `api.default`, …). */
  name: string;
  scope: RateScope;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
  /** Deny when Redis is unavailable (login, password reset). Default: allow and log. */
  failClosed?: boolean;
  /**
   * Calendar-aligned fixed windows (S7-04 daily quotas): the count resets at the end of each window (UTC midnight for
   * `windowSeconds: 86_400`), so a caller can be told the exact reset time. Default: sliding window.
   */
  fixedWindow?: boolean;
  /**
   * Penalty box (S7-04 anti-scraping): the first request over the limit denies every request of this identity under
   * this rule for `penaltySeconds` (the result says `tripped` once, then `penalized`), instead of letting requests
   * through again as soon as the window slides.
   */
  penaltySeconds?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until a request of the same cost would be allowed; 0 when allowed. */
  retryAfterSeconds: number;
  /** When the current window ends (epoch ms): a fixed window's reset time (daily quota → next UTC midnight). */
  resetAtMs: number;
  /** This request went over the limit and started the rule's penalty (once per penalty). */
  tripped?: boolean;
  /** Denied by a running penalty (`penaltySeconds`), not by the count. */
  penalized?: boolean;
}

export interface RateLimiterOptions {
  /**
   * A Redis that never evicts (redis-queue, S1-F6). On an evicting cache, memory pressure would reset
   * login counters, which an attacker can cause by filling the cache.
   */
  redis: Redis;
  prefix?: string;
  logger: Logger;
  /** `HMAC_KEY`: identities are keyed-hashed, so IPs cannot be recovered from Redis by brute force. */
  hmacKey: string | Uint8Array;
  clock?: Clock;
}

const NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
/** Credential endpoints must deny when Redis is unavailable, or an outage opens them to brute force. */
const CREDENTIAL_RULE_RE = /^(auth|password|2fa)\./;

/**
 * Sliding-window counter: the previous fixed window's count weighted by how much of it still overlaps the sliding
 * window, plus the current window's count. Two small keys per identity, atomic in one script. Fixed windows (S7-04)
 * ignore the previous window and expire at their reset. With a penalty (S7-04), the rule's third key holds the epoch ms
 * the penalty ends (the caller's clock, so tests can move it): while it runs nothing is counted and the rule denies;
 * the first request over the limit sets it.
 *
 * Several rules go in one call (S7-04: a website request checks up to eleven), in two phases: every rule is judged
 * first; then each allowed rule is counted — except `countLast` rules (daily quotas), which count only when every
 * non-`observe` rule allowed, so refused requests never burn a quota. 3 keys and 9 arguments per rule, 5 numbers back
 * per rule: {allowed, current, previous, penaltyLeftMs, tripped}; the weighted estimate is computed in JS (Lua would
 * truncate floats). Only GET, INCRBY and PEXPIRE: the production `limits` ACL user (infra/ansible group_vars) allows no
 * more.
 */
const CONSUME = `
local n = #KEYS / 3
local verdicts = {}
local allOk = true
for r = 0, n - 1 do
  local k = r * 3
  local a = r * 9
  local limit = tonumber(ARGV[a + 1])
  local windowMs = tonumber(ARGV[a + 2])
  local elapsed = tonumber(ARGV[a + 3])
  local cost = tonumber(ARGV[a + 4])
  local fixed = ARGV[a + 5] == '1'
  local penaltyMs = tonumber(ARGV[a + 6])
  local now = tonumber(ARGV[a + 7])
  local observe = ARGV[a + 8] == '1'
  local v = nil
  local untilMs = 0
  if penaltyMs > 0 then
    untilMs = tonumber(redis.call('GET', KEYS[k + 3]) or '0')
    if untilMs > now then v = {0, 0, 0, untilMs - now, 0} end
  end
  if v == nil then
    local cur = tonumber(redis.call('GET', KEYS[k + 1]) or '0')
    local prev = 0
    if not fixed then prev = tonumber(redis.call('GET', KEYS[k + 2]) or '0') end
    if prev * (windowMs - elapsed) / windowMs + cur + cost > limit then
      if penaltyMs > 0 then
        -- INCRBY to the new end (no SET in the ACL): the key may still hold an ended penalty's value.
        redis.call('INCRBY', KEYS[k + 3], now + penaltyMs - untilMs)
        redis.call('PEXPIRE', KEYS[k + 3], penaltyMs)
        v = {0, cur, prev, penaltyMs, 1}
      else
        v = {0, cur, prev, 0, 0}
      end
    else
      v = {1, cur, prev, 0, 0}
    end
  end
  verdicts[r + 1] = v
  if v[1] == 0 and not observe then allOk = false end
end
local out = {}
for r = 0, n - 1 do
  local k = r * 3
  local a = r * 9
  local v = verdicts[r + 1]
  if v[1] == 1 and (allOk or ARGV[a + 9] ~= '1') then
    local windowMs = tonumber(ARGV[a + 2])
    local elapsed = tonumber(ARGV[a + 3])
    local cost = tonumber(ARGV[a + 4])
    local cur = redis.call('INCRBY', KEYS[k + 1], cost)
    if cur == cost then
      -- A fixed window's key goes at its reset (+1 s); a sliding one is read as "previous" for one more window.
      if ARGV[a + 5] == '1' then
        redis.call('PEXPIRE', KEYS[k + 1], windowMs - elapsed + 1000)
      else
        redis.call('PEXPIRE', KEYS[k + 1], windowMs * 2)
      end
    end
    v[2] = cur
  end
  for i = 1, 5 do out[#out + 1] = v[i] end
end
return out
`;

/** `numKeys` first (ioredis: a command defined without `numberOfKeys`), then the keys, then the arguments. */
type ConsumeFn = (numKeys: number, ...keysAndArgs: (string | number)[]) => Promise<number[]>;

export function assertRule(rule: RateLimitRule): void {
  if (!NAME_RE.test(rule.name)) throw new TypeError(`invalid rate limit name "${rule.name}"`);
  if (!Number.isInteger(rule.limit) || rule.limit < 1) throw new RangeError(`${rule.name}: limit must be ≥ 1`);
  if (!Number.isInteger(rule.windowSeconds) || rule.windowSeconds < 1) {
    throw new RangeError(`${rule.name}: windowSeconds must be ≥ 1`);
  }
  if (CREDENTIAL_RULE_RE.test(rule.name) && rule.failClosed !== true) {
    throw new TypeError(`${rule.name}: credential rules (auth.*, password.*, 2fa.*) must set failClosed`);
  }
  if (rule.penaltySeconds !== undefined && (!Number.isInteger(rule.penaltySeconds) || rule.penaltySeconds < 1)) {
    throw new RangeError(`${rule.name}: penaltySeconds must be ≥ 1`);
  }
}

/**
 * Milliseconds until `prev·(w − e − t)/w + cur + cost ≤ limit` holds, rolling into the next window
 * (where today's `cur` becomes the weighted previous count) when needed.
 */
export function retryAfterMs(
  limit: number,
  windowMs: number,
  elapsed: number,
  cur: number,
  prev: number,
  cost: number,
): number {
  const room = limit - cost - cur;
  if (room >= 0 && prev > 0) {
    // Still inside this window: wait until enough of the previous window slides out.
    return Math.max(0, windowMs - elapsed - (windowMs * room) / prev);
  }
  // Next window: `cur` is the previous count there, weighted by (w − e′)/w.
  const untilNext = windowMs - elapsed;
  if (cur <= 0) return untilNext;
  return untilNext + Math.max(0, windowMs * (1 - (limit - cost) / cur));
}

/** One rule to count: what `consume` takes, for `consumeMany`. */
export interface RateLimitCheck {
  rule: RateLimitRule;
  identity: string;
  cost?: number;
  /** Alert-only (S7-04): its denial never stops the others' `countLast` counting; the caller decides what it means. */
  observe?: boolean;
  /** Counted only when every non-`observe` rule of the call allowed the request (daily quotas, S7-04). */
  countLast?: boolean;
}

export interface ConsumeManyOptions {
  /**
   * Redis Cluster hash slot of every key of the call (S7-04): one script touches them all, so they must share a slot.
   * Pass a stable id the rules belong to (the website API passes the agency). Without it each rule's keys are tagged
   * by their own identity, which is cluster-safe for one rule only.
   */
  slot?: string;
}

/** Fail-open warnings are sampled: one line per this many ms per limiter, with the number of calls folded into it. */
const FAILURE_LOG_INTERVAL_MS = 10_000;

export class RateLimiter {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly hmacKey: Uint8Array;
  private lastFailureLogMs = Number.NEGATIVE_INFINITY;
  private suppressedFailures = 0;

  constructor(options: RateLimiterOptions) {
    this.redis = options.redis;
    this.prefix = options.prefix ?? 'inl:rl';
    this.logger = options.logger;
    this.clock = options.clock ?? processClock;
    // One Buffer for the process: the HMAC helper caches its derived subkey per key object (a string would derive it
    // again on every request — S7-04 checks up to eleven rules per request).
    this.hmacKey = Buffer.from(options.hmacKey);
    if (!('inlRateConsumeN' in this.redis)) {
      this.redis.defineCommand('inlRateConsumeN', { lua: CONSUME });
    }
  }

  private hashOf(value: string): string {
    return hmacSha256(this.hmacKey, 'rate-limit', value).slice(0, 22);
  }

  /**
   * Counts one request (or `cost`) for `identity` under `rule`. Identities are HMAC'd into the key, so
   * IPs and user IDs never appear in Redis in clear.
   */
  async consume(rule: RateLimitRule, identity: string, cost = 1): Promise<RateLimitResult> {
    const [result] = await this.consumeMany([{ rule, identity, cost }]);
    return result as RateLimitResult;
  }

  /**
   * `consume` for several rules in one script call — one Redis round trip, however many rules (S7-04). Each rule is
   * judged on its own; `countLast` rules count only when every non-`observe` rule allowed. Results in the order of
   * `checks`.
   */
  async consumeMany(checks: readonly RateLimitCheck[], options: ConsumeManyOptions = {}): Promise<RateLimitResult[]> {
    const now = this.clock.nowMs();
    const slot = options.slot === undefined ? undefined : this.hashOf(options.slot);
    const keys: string[] = [];
    const args: number[] = [];
    const plans = checks.map(({ rule, identity, cost = 1, observe, countLast }) => {
      assertRule(rule);
      if (!Number.isInteger(cost) || cost < 1) throw new RangeError('cost must be a positive integer');
      if (cost > rule.limit) throw new RangeError(`${rule.name}: cost ${cost} exceeds the limit`);
      const windowMs = rule.windowSeconds * 1_000;
      const index = Math.floor(now / windowMs);
      const elapsed = now - index * windowMs;
      const id = this.hashOf(identity);
      // `{…}` is the Redis Cluster hash tag: every key of one call lands in one slot.
      const base =
        slot === undefined
          ? `${this.prefix}:${rule.name}:${rule.scope}:{${id}}`
          : `${this.prefix}:{${slot}}:${rule.name}:${rule.scope}:${id}`;
      const fixed = rule.fixedWindow === true;
      keys.push(`${base}:${index}`, `${base}:${index - 1}`, `${base}:pen`);
      args.push(
        rule.limit,
        windowMs,
        elapsed,
        cost,
        fixed ? 1 : 0,
        (rule.penaltySeconds ?? 0) * 1_000,
        now,
        observe ? 1 : 0,
        countLast ? 1 : 0,
      );
      return { rule, cost, windowMs, elapsed, fixed, resetAtMs: (index + 1) * windowMs };
    });
    if (plans.length === 0) return [];

    try {
      await whenReady(this.redis);
      const consume = (this.redis as unknown as { inlRateConsumeN: ConsumeFn }).inlRateConsumeN.bind(this.redis);
      const out = await consume(keys.length, ...keys, ...args);
      return plans.map((p, i) => {
        const [ok, cur, prev, penaltyLeftMs, tripped] = out.slice(i * 5, i * 5 + 5) as [
          number,
          number,
          number,
          number,
          number,
        ];
        const { rule, windowMs, elapsed, fixed, resetAtMs } = p;
        if (ok === 1) {
          const estimate = (fixed ? 0 : (prev * (windowMs - elapsed)) / windowMs) + cur;
          return {
            allowed: true,
            limit: rule.limit,
            remaining: Math.max(0, Math.floor(rule.limit - estimate)),
            retryAfterSeconds: 0,
            resetAtMs,
          };
        }
        if (penaltyLeftMs > 0) {
          return {
            allowed: false,
            limit: rule.limit,
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil(penaltyLeftMs / 1_000)),
            resetAtMs: now + penaltyLeftMs,
            ...(tripped === 1 ? { tripped: true } : { penalized: true }),
          };
        }
        const waitMs = fixed ? windowMs - elapsed : retryAfterMs(rule.limit, windowMs, elapsed, cur, prev, p.cost);
        return {
          allowed: false,
          limit: rule.limit,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000)),
          resetAtMs,
        };
      });
    } catch (err) {
      this.logFailure(err, plans);
      return plans.map(({ rule, resetAtMs }) =>
        rule.failClosed
          ? { allowed: false, limit: rule.limit, remaining: 0, retryAfterSeconds: rule.windowSeconds, resetAtMs }
          : { allowed: true, limit: rule.limit, remaining: rule.limit, retryAfterSeconds: 0, resetAtMs },
      );
    }
  }

  /** One warning per failed call at most every 10 s (an outage would otherwise log every request), naming its rules. */
  private logFailure(err: unknown, plans: readonly { rule: RateLimitRule }[]): void {
    const now = Date.now();
    if (now - this.lastFailureLogMs < FAILURE_LOG_INTERVAL_MS) {
      this.suppressedFailures++;
      return;
    }
    this.lastFailureLogMs = now;
    const suppressed = this.suppressedFailures;
    this.suppressedFailures = 0;
    this.logger.warn(
      {
        err,
        rules: plans.map((p) => p.rule.name),
        failClosed: plans.filter((p) => p.rule.failClosed === true).map((p) => p.rule.name),
        suppressed,
      },
      'rate limit check failed',
    );
  }
}
