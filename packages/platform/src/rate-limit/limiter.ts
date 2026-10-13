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
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until a request of the same cost would be allowed; 0 when allowed. */
  retryAfterSeconds: number;
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
 * Sliding-window counter: the previous fixed window's count weighted by how much of it still overlaps
 * the sliding window, plus the current window's count. Two small keys per identity, atomic in one script.
 * Returns {allowed, current, previous}; the weighted estimate is computed in JS (Lua would truncate floats).
 */
const CONSUME = `
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local elapsed = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
if prev * (windowMs - elapsed) / windowMs + cur + cost > limit then
  return {0, cur, prev}
end
cur = redis.call('INCRBY', KEYS[1], cost)
if cur == cost then redis.call('PEXPIRE', KEYS[1], windowMs * 2) end
return {1, cur, prev}
`;

type ConsumeFn = (cur: string, prev: string, ...args: (string | number)[]) => Promise<[number, number, number]>;

export function assertRule(rule: RateLimitRule): void {
  if (!NAME_RE.test(rule.name)) throw new TypeError(`invalid rate limit name "${rule.name}"`);
  if (!Number.isInteger(rule.limit) || rule.limit < 1) throw new RangeError(`${rule.name}: limit must be ≥ 1`);
  if (!Number.isInteger(rule.windowSeconds) || rule.windowSeconds < 1) {
    throw new RangeError(`${rule.name}: windowSeconds must be ≥ 1`);
  }
  if (CREDENTIAL_RULE_RE.test(rule.name) && rule.failClosed !== true) {
    throw new TypeError(`${rule.name}: credential rules (auth.*, password.*, 2fa.*) must set failClosed`);
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

export class RateLimiter {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly hmacKey: string | Uint8Array;

  constructor(options: RateLimiterOptions) {
    this.redis = options.redis;
    this.prefix = options.prefix ?? 'inl:rl';
    this.logger = options.logger;
    this.clock = options.clock ?? processClock;
    this.hmacKey = options.hmacKey;
    if (!('inlRateConsume' in this.redis)) {
      this.redis.defineCommand('inlRateConsume', { numberOfKeys: 2, lua: CONSUME });
    }
  }

  /**
   * Counts one request (or `cost`) for `identity` under `rule`. Identities are HMAC'd into the key, so
   * IPs and user IDs never appear in Redis in clear.
   */
  async consume(rule: RateLimitRule, identity: string, cost = 1): Promise<RateLimitResult> {
    assertRule(rule);
    if (!Number.isInteger(cost) || cost < 1) throw new RangeError('cost must be a positive integer');
    if (cost > rule.limit) throw new RangeError(`${rule.name}: cost ${cost} exceeds the limit`);
    const windowMs = rule.windowSeconds * 1_000;
    const now = this.clock.nowMs();
    const index = Math.floor(now / windowMs);
    const elapsed = now - index * windowMs;
    const id = hmacSha256(this.hmacKey, 'rate-limit', identity).slice(0, 22);
    const base = `${this.prefix}:${rule.name}:${rule.scope}:${id}`;

    try {
      await whenReady(this.redis);
      const consume = (this.redis as unknown as { inlRateConsume: ConsumeFn }).inlRateConsume.bind(this.redis);
      const [ok, cur, prev] = await consume(
        `${base}:${index}`,
        `${base}:${index - 1}`,
        rule.limit,
        windowMs,
        elapsed,
        cost,
      );
      const estimate = (prev * (windowMs - elapsed)) / windowMs + cur;
      if (ok === 1) {
        return {
          allowed: true,
          limit: rule.limit,
          remaining: Math.max(0, Math.floor(rule.limit - estimate)),
          retryAfterSeconds: 0,
        };
      }
      const waitMs = retryAfterMs(rule.limit, windowMs, elapsed, cur, prev, cost);
      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000)),
      };
    } catch (err) {
      this.logger.warn({ err, rule: rule.name, failClosed: rule.failClosed === true }, 'rate limit check failed');
      return rule.failClosed
        ? { allowed: false, limit: rule.limit, remaining: 0, retryAfterSeconds: rule.windowSeconds }
        : { allowed: true, limit: rule.limit, remaining: rule.limit, retryAfterSeconds: 0 };
    }
  }
}
