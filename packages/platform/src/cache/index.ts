import { Redis, type RedisOptions } from 'ioredis';
import { loadConfig, redisEnv } from '../config';
import { createLogger, type Logger } from '../logger';
import { Cache, type CacheGetOptions } from './cache';
import type { CacheKey } from './key';

export { Cache, type CacheGetOptions, type CacheOptions } from './cache';
export { assertCacheKey, type CacheKey, type CacheKeyParts, cacheKey } from './key';
export { LocalLru } from './lru';
export { whenReady } from './ready';

export interface CacheConfig {
  /** redis-cache (allkeys-lru). Defaults to `REDIS_CACHE_URL` — never redis-queue. */
  url?: string;
  /** Key prefix (default `inl:c`); tests use their own. */
  prefix?: string;
  logger?: Logger;
}

interface State {
  url: string;
  prefix: string;
  logger: Logger;
  redis?: Redis;
  cache?: Cache;
}

let state: State | undefined;

/**
 * RESP2 like the queue connections. No offline queue: while redis-cache is down, commands fail at once
 * (callers fall back to the loader / the rule's fail mode) instead of waiting; `whenReady` covers boot.
 * A slow server is cut off after 200 ms.
 */
const options: RedisOptions = {
  protocol: 2,
  connectionName: 'inmolink-cache',
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 200,
  enableAutoPipelining: true,
};

function fromEnv(config: CacheConfig = {}): State {
  return {
    url: config.url ?? loadConfig({ REDIS_CACHE_URL: redisEnv.REDIS_CACHE_URL }).REDIS_CACHE_URL,
    prefix: config.prefix ?? 'inl:c',
    logger: config.logger ?? createLogger({ service: 'cache', level: process.env.LOG_LEVEL }),
  };
}

/** Sets the Redis URL and prefix. Apps call it once at boot; without it the first use reads `REDIS_CACHE_URL`. */
export async function configureCache(config: CacheConfig = {}): Promise<void> {
  await closeCache();
  state = fromEnv(config);
}

function current(): State {
  state ??= fromEnv();
  return state;
}

/** The shared redis-cache connection (cache + rate limits). */
export function cacheConnection(): Redis {
  const s = current();
  if (!s.redis) {
    s.redis = new Redis(s.url, options);
    s.redis.on('error', (err) => s.logger.warn({ err }, 'redis-cache error'));
  }
  return s.redis;
}

export const cacheLogger = (): Logger => current().logger;

export type { Redis };

/**
 * A dedicated publish/subscribe pair on redis-cache for the Socket.io Redis adapter (realtime).
 * Pub/sub writes no keys, so allkeys-lru eviction cannot touch it. The caller quits both on shutdown.
 */
export function pubSubConnections(): { pub: Redis; sub: Redis } {
  const s = current();
  const pub = new Redis(s.url, { protocol: 2, connectionName: 'inmolink-pubsub' });
  const sub = pub.duplicate();
  for (const conn of [pub, sub]) conn.on('error', (err) => s.logger.warn({ err }, 'redis-cache pub/sub error'));
  return { pub, sub };
}

function instance(): Cache {
  const s = current();
  s.cache ??= new Cache({ redis: cacheConnection(), prefix: s.prefix, logger: s.logger });
  return s.cache;
}

/** Process-wide cache on redis-cache (PATTERNS §15). */
export const cache = {
  get: <T>(key: CacheKey, opts: CacheGetOptions, loader: () => Promise<T>): Promise<T> =>
    instance().get(key, opts, loader),
  set: (key: CacheKey, value: unknown, opts: Omit<CacheGetOptions, 'local'>): Promise<void> =>
    instance().set(key, value, opts),
  delete: (key: CacheKey): Promise<void> => instance().delete(key),
  invalidateTag: (tag: string): Promise<void> => instance().invalidateTag(tag),
  invalidateTags: (tags: readonly string[]): Promise<void> => instance().invalidateTags(tags),
  clearLocal: (): void => instance().clearLocal(),
};

/** Graceful shutdown. */
export async function closeCache(): Promise<void> {
  const s = state;
  state = undefined;
  await s?.redis?.quit().catch(() => s.redis?.disconnect());
}
