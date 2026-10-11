import { cacheConnection, cacheLogger } from '../cache';
import { cryptoEnv, loadConfig } from '../config';
import { RateLimiter } from './limiter';

export {
  ipBucket,
  type RateLimitPluginOptions,
  rateLimitPlugin,
  replyRateLimited,
  type ScopeIdentity,
} from './fastify';
export {
  assertRule,
  RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
  type RateLimitRule,
  type RateScope,
  retryAfterMs,
} from './limiter';

let shared: { redis: ReturnType<typeof cacheConnection>; limiter: RateLimiter } | undefined;

/** Process-wide limiter on the redis-cache connection (`configureCache` sets URL and logger). */
export function rateLimiter(): RateLimiter {
  const redis = cacheConnection();
  if (shared?.redis !== redis) {
    const { HMAC_KEY } = loadConfig({ HMAC_KEY: cryptoEnv.HMAC_KEY });
    shared = { redis, limiter: new RateLimiter({ redis, logger: cacheLogger(), hmacKey: HMAC_KEY }) };
  }
  return shared.limiter;
}
