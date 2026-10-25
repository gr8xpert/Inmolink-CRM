import type { Redis } from 'ioredis';
import { newId } from '../ids';
import type { Logger } from '../logger';
import { assertCacheKey, type CacheKey } from './key';
import { LocalLru } from './lru';
import { whenReady } from './ready';

export interface CacheGetOptions {
  /** Redis TTL in seconds (≥ 1). */
  ttlSeconds: number;
  /** Invalidation tags: `invalidateTag(tag)` makes every entry stored with it miss. */
  tags?: readonly string[];
  /** Also keep the value in the in-process LRU for up to 60 s. Hot config only (PATTERNS §15). */
  local?: boolean;
  /** In-process TTL in seconds when shorter than `ttlSeconds` (e.g. revocable credentials, S1-05). */
  localTtlSeconds?: number;
}

export interface CacheOptions {
  redis: Redis;
  /** Key namespace in redis-cache (default `inl:c`); tests use their own. */
  prefix?: string;
  logger: Logger;
  /** In-process LRU size (default 1 000 entries). */
  localMaxEntries?: number;
  /** In-process TTL cap in seconds (default 60). */
  localTtlSeconds?: number;
}

const TAG_RE = /^[A-Za-z0-9:._-]{1,200}$/;

interface Stored {
  /** The value. */
  v: unknown;
  /** Version of each tag when the value was loaded. */
  t: Record<string, string>;
}

/** A corrupt or foreign entry counts as a miss and is overwritten by the next load. */
function parseStored(raw: string | null): Stored | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return parsed && typeof parsed === 'object' && parsed.t && typeof parsed.t === 'object' && 'v' in parsed
      ? (parsed as Stored)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Shared in-process values must not be mutated by one request under another (e.g. Client Mode stripping). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const FREEZE_LOCAL = process.env.NODE_ENV !== 'production';

function assertTags(tags: readonly string[]): void {
  for (const tag of tags) if (!TAG_RE.test(tag)) throw new TypeError(`invalid cache tag "${tag.slice(0, 40)}"`);
}

/**
 * Read-through cache on redis-cache (allkeys-lru). PLAN §5.3, PATTERNS §15.
 *
 * - **Keys come from `cacheKey()`** and always name their tenant scope (`global` or an agency), so a
 *   value loaded under one agency's RLS is never served to another.
 * - **Single-flight**: concurrent misses on one key in this process share one loader call.
 * - **In-process copies** (`local: true`) are shared by reference and deep-frozen outside production.
 * - **Tags are versions**, not key sets: each tag has a random version; an entry records the versions it
 *   was loaded under and misses when any has changed. Invalidation is one SET, and it stays correct
 *   when LRU eviction drops a tag key (a missing version never matches). A version read before the
 *   loader runs means a concurrent invalidation always wins.
 * - **Values are JSON**: hits and misses both return a JSON round trip of the loader's result.
 * - **Degrades** when Redis is down or slow: errors are logged and the loader result is returned
 *   uncached (PLAN §5.4 — "redis-cache down: slightly slower").
 */
export class Cache {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly logger: Logger;
  private readonly local: LocalLru;
  private readonly localTtlMs: number;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(options: CacheOptions) {
    this.redis = options.redis;
    this.prefix = options.prefix ?? 'inl:c';
    this.logger = options.logger;
    this.local = new LocalLru(options.localMaxEntries ?? 1_000);
    this.localTtlMs = (options.localTtlSeconds ?? 60) * 1_000;
  }

  private entryKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  private tagKey(tag: string): string {
    return `${this.prefix}:tag:${tag}`;
  }

  /** Returns the cached value, or runs `loader` once (per process) and caches its result. */
  async get<T>(key: CacheKey, options: CacheGetOptions, loader: () => Promise<T>): Promise<T> {
    assertCacheKey(key);
    const tags = options.tags ?? [];
    assertTags(tags);
    if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 1) {
      throw new RangeError('ttlSeconds must be a positive integer');
    }

    if (options.local) {
      const hit = this.local.get(key);
      if (hit !== undefined) return hit as T;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = this.load(key, options, tags, loader).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async load<T>(
    key: CacheKey,
    options: CacheGetOptions,
    tags: readonly string[],
    loader: () => Promise<T>,
  ): Promise<T> {
    let versions: Record<string, string> | undefined;
    try {
      await whenReady(this.redis);
      const raw = await this.redis.mget(this.entryKey(key), ...tags.map((t) => this.tagKey(t)));
      const current = raw.slice(1);
      const stored = parseStored(raw[0] ?? null);
      if (stored && tags.every((tag, i) => current[i] !== null && stored.t[tag] === current[i])) {
        this.remember(key, stored.v, options, tags);
        return stored.v as T;
      }
      versions = await this.tagVersions(tags, current);
    } catch (err) {
      this.logger.warn({ err, cacheKey: key }, 'cache read failed; loading without cache');
    }

    const loaded = await loader();
    // undefined is not representable in JSON; such results are returned but never cached.
    if (loaded === undefined) return loaded;
    // Misses return the same JSON round trip as hits, so a Date (say) is a string either way.
    const json = JSON.stringify({ v: loaded, t: versions ?? {} } satisfies Stored);
    const value = (JSON.parse(json) as Stored).v as T;
    if (versions) {
      try {
        await this.redis.set(this.entryKey(key), json, 'EX', options.ttlSeconds);
      } catch (err) {
        this.logger.warn({ err, cacheKey: key }, 'cache write failed');
      }
    }
    this.remember(key, value, options, tags);
    return value;
  }

  /** Current tag versions; creates missing ones (`SET NX GET` keeps whichever writer won). */
  private async tagVersions(tags: readonly string[], current: (string | null)[]): Promise<Record<string, string>> {
    const versions: Record<string, string> = {};
    await Promise.all(
      tags.map(async (tag, i) => {
        const existing = current[i];
        if (existing) {
          versions[tag] = existing;
          return;
        }
        const fresh = newId();
        const previous = await this.redis.set(this.tagKey(tag), fresh, 'NX', 'GET');
        versions[tag] = previous ?? fresh;
      }),
    );
    return versions;
  }

  private remember(key: CacheKey, value: unknown, options: CacheGetOptions, tags: readonly string[]): void {
    if (!options.local) return;
    this.local.set(
      key,
      FREEZE_LOCAL ? deepFreeze(value) : value,
      Math.min((options.localTtlSeconds ?? options.ttlSeconds) * 1_000, options.ttlSeconds * 1_000, this.localTtlMs),
      tags,
    );
  }

  /** Writes a value directly (e.g. a worker that just rebuilt it). */
  async set(key: CacheKey, value: unknown, options: Omit<CacheGetOptions, 'local'>): Promise<void> {
    assertCacheKey(key);
    const tags = options.tags ?? [];
    assertTags(tags);
    if (value === undefined) throw new TypeError('cannot cache undefined');
    await whenReady(this.redis);
    const current = tags.length > 0 ? await this.redis.mget(...tags.map((t) => this.tagKey(t))) : [];
    const versions = await this.tagVersions(tags, current);
    await this.redis.set(this.entryKey(key), JSON.stringify({ v: value, t: versions }), 'EX', options.ttlSeconds);
    this.local.delete(key);
  }

  /**
   * S12-03: the stored values of many keys in one MGET, without a loader — for values a worker writes (`set`) and a
   * request only reads (the white-label sanitizer's cached model removals). Untagged entries only (a tagged one reads
   * as a miss). A miss, a corrupt entry or redis-cache being down is `undefined`: the caller falls back.
   */
  async peekMany(keys: readonly CacheKey[]): Promise<unknown[]> {
    for (const key of keys) assertCacheKey(key);
    if (keys.length === 0) return [];
    try {
      await whenReady(this.redis);
      const raw = await this.redis.mget(...keys.map((k) => this.entryKey(k)));
      return raw.map((r) => {
        const stored = parseStored(r ?? null);
        return stored && Object.keys(stored.t).length === 0 ? stored.v : undefined;
      });
    } catch (err) {
      this.logger.warn({ err, keys: keys.length }, 'cache peek failed; reading as misses');
      return keys.map(() => undefined);
    }
  }

  async delete(key: CacheKey): Promise<void> {
    assertCacheKey(key);
    this.local.delete(key);
    await whenReady(this.redis);
    await this.redis.del(this.entryKey(key));
  }

  /**
   * Makes every entry stored under `tag` miss. Event-driven — call it from an outbox subscriber,
   * never inline in a request (PATTERNS §15). Other processes' in-process copies expire within 60 s.
   */
  async invalidateTag(tag: string): Promise<void> {
    await this.invalidateTags([tag]);
  }

  async invalidateTags(tags: readonly string[]): Promise<void> {
    assertTags(tags);
    for (const tag of tags) this.local.deleteTagged(tag);
    if (tags.length === 0) return;
    await whenReady(this.redis);
    const pipeline = this.redis.pipeline();
    for (const tag of tags) pipeline.set(this.tagKey(tag), newId());
    const results = await pipeline.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
  }

  /** Drops this process's in-process copies (tests, or after a local write). */
  clearLocal(): void {
    this.local.clear();
  }
}
