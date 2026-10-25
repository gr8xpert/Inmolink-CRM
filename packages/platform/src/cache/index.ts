import { Redis, type RedisOptions } from 'ioredis';
import { loadConfig, realtimeEventsEnv, redisEnv } from '../config';
import { createLogger, type Logger } from '../logger';
import { Cache, type CacheGetOptions } from './cache';
import type { CacheKey } from './key';
import { SeenTimes } from './seen';
import { encodeUserEvent, USER_EVENTS_CHANNEL, type UserEvent } from './user-events';

export { Cache, type CacheGetOptions, type CacheOptions } from './cache';
export { assertCacheKey, type CacheKey, type CacheKeyParts, cacheKey } from './key';
export { LocalLru } from './lru';
export { whenReady } from './ready';
export { SeenTimes } from './seen';
export {
  decodeUserEvent,
  encodeUserEvent,
  MAX_USER_EVENT_BYTES,
  type SubscribeUserEventsOptions,
  subscribeUserEvents,
  USER_EVENTS_CHANNEL,
  type UserEvent,
  userEventRecipient,
} from './user-events';

export interface CacheConfig {
  /** redis-cache (allkeys-lru). Defaults to `REDIS_CACHE_URL` — never redis-queue. */
  url?: string;
  /** Key prefix (default `inl:c`); tests use their own. */
  prefix?: string;
  logger?: Logger;
  /**
   * Cut-off for one command (default 200 ms). Tests that check limiter counting on a CPU-starved
   * machine raise it; a slow cache in production must fail fast instead.
   */
  commandTimeoutMs?: number;
  /** S12-F4: prefix published user events with their recipient (default `REALTIME_PREFIX_EVENTS`, off). */
  prefixUserEvents?: boolean;
}

interface State {
  url: string;
  prefix: string;
  logger: Logger;
  commandTimeoutMs: number;
  prefixUserEvents: boolean;
  redis?: Redis;
  cache?: Cache;
  seen?: SeenTimes;
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
    commandTimeoutMs: config.commandTimeoutMs ?? 200,
    prefixUserEvents: config.prefixUserEvents ?? loadConfig(realtimeEventsEnv).REALTIME_PREFIX_EVENTS === 'true', // S12-F4
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
    s.redis = new Redis(s.url, { ...options, commandTimeout: s.commandTimeoutMs });
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

/**
 * Publishes per-user realtime events (S11-04) on the shared redis-cache connection (`user-events.ts`), in one pipeline
 * (one round trip for a fan-out of 100). Every event is encoded (and checked) before anything is sent. Fails fast like
 * every cache command (no offline queue): the caller — a worker job — retries.
 */
export async function publishUserEvents(events: readonly UserEvent[]): Promise<void> {
  if (events.length === 0) return;
  const { prefixUserEvents } = current(); // S12-F4: the rollout flag
  const encoded = events.map((e) => encodeUserEvent(e, { prefix: prefixUserEvents }));
  const pipeline = cacheConnection().pipeline();
  for (const text of encoded) pipeline.publish(USER_EVENTS_CHANNEL, text);
  const results = await pipeline.exec();
  const failed = results?.find(([err]) => err);
  if (failed?.[0]) throw failed[0];
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

/** Process-wide "last seen" times on redis-cache (API key usage, S1-05). */
export const seen = {
  mark: (set: string, id: string, at: Date): Promise<void> => seenInstance().mark(set, id, at),
  drain: (set: string): Promise<Map<string, Date>> => seenInstance().drain(set),
};

function seenInstance(): SeenTimes {
  const s = current();
  s.seen ??= new SeenTimes(cacheConnection(), s.prefix, s.logger);
  return s.seen;
}

/**
 * S12-F10: a member's realtime revocation, shared by every realtime node (a restarted node, or one that missed the
 * pub/sub message, still refuses the old token). Workers write it before publishing; it lives as long as a token
 * issued before it can (`ttlSeconds`). allkeys-lru may evict it early: nodes also keep what they heard in memory.
 */
export interface SessionRevocation {
  /** Epoch ms of the deactivation, or null. */
  deactivatedAt: number | null;
  /** Tokens with an older `sv` are refused, or null. */
  sessionVersion: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function revocationKey(agencyId: string, userId: string): string {
  if (!UUID_RE.test(agencyId) || !UUID_RE.test(userId)) throw new TypeError('session revocation: ids must be UUIDs');
  return `${current().prefix}:rt:revoked:${agencyId}:${userId}`;
}

/** Stores the fields given (each one the database's current value), and (re)sets the expiry. */
export async function markSessionRevoked(
  agencyId: string,
  userId: string,
  r: Partial<SessionRevocation>,
  ttlSeconds: number,
): Promise<void> {
  const key = revocationKey(agencyId, userId);
  const fields: Record<string, string> = {};
  if (r.deactivatedAt != null) fields.dv = String(r.deactivatedAt);
  if (r.sessionVersion != null) fields.sv = String(r.sessionVersion);
  if (Object.keys(fields).length === 0) return;
  const results = await cacheConnection().multi().hset(key, fields).expire(key, ttlSeconds).exec();
  const failed = results?.find(([err]) => err);
  if (failed?.[0]) throw failed[0];
}

/** The member's revocation, or null (none, expired or evicted). Errors reach the caller (realtime fails open). */
export async function sessionRevocation(agencyId: string, userId: string): Promise<SessionRevocation | null> {
  const [dv, sv] = await cacheConnection().hmget(revocationKey(agencyId, userId), 'dv', 'sv');
  if (dv == null && sv == null) return null;
  const num = (v: string | null | undefined) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return { deactivatedAt: num(dv), sessionVersion: num(sv) };
}

/** Graceful shutdown. */
export async function closeCache(): Promise<void> {
  const s = state;
  state = undefined;
  await s?.redis?.quit().catch(() => s.redis?.disconnect());
}
