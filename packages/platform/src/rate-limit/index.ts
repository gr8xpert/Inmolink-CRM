import { Redis, type RedisOptions } from 'ioredis';
import { cryptoEnv, loadConfig, rateLimitEnv } from '../config';
import { createLogger, type Logger } from '../logger';
import { RateLimiter } from './limiter';

export {
  ipBucket,
  type RateLimitPluginOptions,
  rateLimitPlugin,
  replyQuotaExceeded,
  replyRateLimited,
  type ScopeIdentity,
} from './fastify';
export {
  assertRule,
  type ConsumeManyOptions,
  type CreditOptions,
  type RateLimitCheck,
  RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
  type RateLimitRule,
  type RateScope,
  retryAfterMs,
} from './limiter';
export {
  createUploadSlots,
  LISTING_DOCUMENT_UPLOAD_SLOTS,
  LISTING_DOCUMENT_UPLOAD_TOTAL,
  type UploadSlots,
} from './upload-slots';

export interface RateLimitConfig {
  /** A Redis that never evicts (redis-queue). Defaults to `REDIS_LIMITS_URL` — never redis-cache (S1-F6). */
  url?: string;
  logger?: Logger;
  /** Cut-off for one command (default 200 ms); tests on a CPU-starved machine raise it. */
  commandTimeoutMs?: number;
}

interface State {
  url: string;
  logger: Logger;
  commandTimeoutMs: number;
  redis?: Redis;
  limiter?: RateLimiter;
}

let state: State | undefined;

/**
 * Same shape as the cache connection: RESP2, no offline queue, a slow server cut off after 200 ms, so
 * an outage resolves through each rule's fail mode at once. Not auto-pipelined: the queue's Redis also
 * serves BullMQ, and a limit check is one script call.
 */
const options: RedisOptions = {
  protocol: 2,
  connectionName: 'inmolink-limits',
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  // The ready check sends INFO, which production's `limits` ACL user is not allowed (it leaks server state).
  enableReadyCheck: false,
};

function fromEnv(config: RateLimitConfig = {}): State {
  return {
    url: config.url ?? loadConfig({ REDIS_LIMITS_URL: rateLimitEnv.REDIS_LIMITS_URL }).REDIS_LIMITS_URL,
    logger: config.logger ?? createLogger({ service: 'rate-limit', level: process.env.LOG_LEVEL }),
    commandTimeoutMs: config.commandTimeoutMs ?? 200,
  };
}

/** Sets the Redis URL. Apps call it once at boot; without it the first use reads `REDIS_LIMITS_URL`. */
export async function configureRateLimit(config: RateLimitConfig = {}): Promise<void> {
  await closeRateLimit();
  state = fromEnv(config);
}

/** The limits connection (tests read and reset counters through it). */
export function rateLimitConnection(): Redis {
  state ??= fromEnv();
  const s = state;
  if (!s.redis) {
    s.redis = new Redis(s.url, { ...options, commandTimeout: s.commandTimeoutMs });
    s.redis.on('error', (err) => s.logger.warn({ err }, 'redis-limits error'));
  }
  return s.redis;
}

/** Process-wide limiter on the limits connection. */
export function rateLimiter(): RateLimiter {
  const redis = rateLimitConnection();
  const s = state as State;
  if (!s.limiter) {
    const { HMAC_KEY } = loadConfig({ HMAC_KEY: cryptoEnv.HMAC_KEY });
    s.limiter = new RateLimiter({ redis, logger: s.logger, hmacKey: HMAC_KEY });
  }
  return s.limiter;
}

/** Graceful shutdown. */
export async function closeRateLimit(): Promise<void> {
  const s = state;
  state = undefined;
  await s?.redis?.quit().catch(() => s.redis?.disconnect());
}
