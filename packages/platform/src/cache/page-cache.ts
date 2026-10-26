/**
 * S15-F7: the public app's Next.js ISR page cache (`cacheHandler` in `apps/public/next.config.ts`, ADR 0019 (A)) and
 * the shared tag times that invalidate it on every instance.
 *
 * - **Bounded per instance.** Rendered pages live in an in-process LRU capped in bytes (Next's `cacheMaxMemorySize`),
 *   never on disk — Next's default handler writes every ISR page to the server's disk, unbounded for ~2M listings ×
 *   locales. A miss only renders the page again (≤ 3 statements); the CDN in front holds the long tail.
 * - **Shared invalidation.** A tag's change time lives on redis-cache (`PageTagStore.markMax`, written by the worker's
 *   outbox subscribers or by `revalidateTag` in any instance; atomic, keeps the later time). On a hit the handler
 *   reads the entry's shared tags' times (one MGET) and drops the entry when a change could postdate what it read:
 *   `lastModified` is when Next stored the page, not when the render read its data, so a change up to
 *   `RENDER_MARGIN_MS` before the store still drops it (a render that read before the change and finished after it;
 *   clock skew between worker and public instances). Every instance sees an invalidation on its next request, with no
 *   instance list, endpoint or broadcast. A time in the future ("settle") keeps the tag's pages uncached until then
 *   (plus the margin) — for changes that other caches take a while to show; while it lasts, `set` does not store
 *   pages carrying the tag (the time is remembered from the lookup that dropped one: no extra Redis call).
 * - **Degrades open.** redis-cache down or slow (200 ms cut-off): the entry is served as cached, and Next's own
 *   `revalidate` (ISR) still renders it again after its lifetime; an evicted tag time does the same. After
 *   `BREAKER_FAILURES` failed lookups in a row the handler skips lookups for `BREAKER_OPEN_MS`, so a slow redis-cache
 *   does not add its cut-off to every hit. Entries older than `PAGE_TAG_TTL_SECONDS` are never served, so a tag time
 *   outlives every entry it could invalidate.
 *
 * Only tags with a shared prefix (`PAGE_TAG_SHARED_PREFIX`) are looked up; Next's implicit path tags stay local.
 */

/**
 * Tags looked up on redis-cache (the portal's: `portal:t:<listing>`, `portal:d:<development>`, `portal:a:<agency>`,
 * `portal:c:<public code>`).
 */
export const PAGE_TAG_SHARED_PREFIX = 'portal:';
/** How long a tag's change time is kept; entries older than this are never served. */
export const PAGE_TAG_TTL_SECONDS = 60 * 60;
/** A page stored up to this long after a change of one of its tags may have read before it: dropped. */
export const RENDER_MARGIN_MS = 30_000;
/** Failed tag lookups in a row that open the breaker, and how long lookups are skipped then. */
export const BREAKER_FAILURES = 3;
export const BREAKER_OPEN_MS = 5_000;
/** Default page cache size when Next passes none (bytes). */
export const DEFAULT_PAGE_CACHE_BYTES = 256 * 1024 * 1024;
/** Settles remembered per process (tags whose pages are not stored for now). */
const MAX_SETTLES = 10_000;
/** Next's header with an entry's cache tags. */
const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';
const TAG_RE = /^[A-Za-z0-9:._-]{1,200}$/;

/** Where tag times live (redis-cache: `redisPageTagStore` in `index.ts`; tests pass a fake). */
export interface PageTagStore {
  /** Each tag's change time (epoch ms) or null; throws when redis-cache is unavailable. */
  read(tags: readonly string[]): Promise<(number | null)[]>;
  /** Sets each tag's time to `atMs` unless it holds a later one — atomically (one script). */
  markMax(tags: readonly string[], atMs: number, ttlSeconds: number): Promise<void>;
}

export const isSharedPageTag = (tag: string): boolean => tag.startsWith(PAGE_TAG_SHARED_PREFIX) && TAG_RE.test(tag);

/**
 * Marks `tags` changed at `atMs` (a later time: "settle" — the tags' pages stay uncached until then). The store keeps
 * the later of the stored and the new time in one atomic step, so a redelivered or older event never shortens a
 * settle, and no read precedes the write. Throws when redis-cache is unavailable (the outbox subscriber is retried).
 */
export async function markPageTagsChanged(store: PageTagStore, tags: readonly string[], atMs: number): Promise<void> {
  const shared = [...new Set(tags)].filter(isSharedPageTag);
  if (shared.length === 0) return;
  await store.markMax(shared, atMs, PAGE_TAG_TTL_SECONDS);
}

// ── The handler ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Entry {
  value: unknown;
  lastModified: number;
  /** Every tag of the entry (Next's header and the `set` context). */
  tags: readonly string[];
  /** The shared ones, looked up on a hit. */
  shared: readonly string[];
  cacheControl: unknown;
  bytes: number;
}

/** Approximate retained size of a cache value: strings, buffers, maps and plain objects (depth-limited). */
export function approximateBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (depth > 6) return 64;
  if (value instanceof Map) {
    let n = 0;
    for (const [k, v] of value) n += approximateBytes(k, depth + 1) + approximateBytes(v, depth + 1);
    return n;
  }
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + approximateBytes(v, depth + 1), 0);
  if (typeof value === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(value)) n += k.length * 2 + approximateBytes(v, depth + 1);
    return n;
  }
  return 0;
}

/** A byte-capped LRU of rendered pages (one per process: Next builds a handler per request). */
export class PageLru {
  private readonly entries = new Map<string, Entry>();
  private used = 0;

  constructor(readonly maxBytes: number) {}

  get bytes(): number {
    return this.used;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }

  set(key: string, entry: Entry): void {
    this.delete(key);
    if (entry.bytes > this.maxBytes) return;
    this.entries.set(key, entry);
    this.used += entry.bytes;
    while (this.used > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.used -= e.bytes;
  }

  /** Drops every entry carrying one of `tags`. */
  deleteTagged(tags: ReadonlySet<string>): void {
    for (const [key, e] of this.entries) if (e.tags.some((t) => tags.has(t))) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }
}

export interface PageCacheOptions {
  store: PageTagStore;
  /** Byte cap of the process's page LRU. */
  maxBytes: number;
  now?: () => number;
  /** A lookup failure (logged by the caller; the entry is served). */
  onError?: (err: unknown) => void;
}

type CacheContext = { tags?: readonly string[]; cacheControl?: unknown } | undefined;

/** The tags an entry carries: Next's `x-next-cache-tags` header (pages) and the `set` context's (fetch / unstable_cache). */
function tagsOf(data: unknown, ctx: CacheContext): string[] {
  const out = new Set<string>(ctx?.tags ?? []);
  const headers = (data as { headers?: Record<string, unknown> } | null)?.headers;
  const header = headers?.[NEXT_CACHE_TAGS_HEADER];
  if (typeof header === 'string') for (const t of header.split(',')) if (t) out.add(t);
  return [...out];
}

/**
 * The page cache's logic behind Next's `CacheHandler` contract (`get`, `set`, `revalidateTag`,
 * `resetRequestCache`). `PageCacheHandler` (`index.ts`) binds it to redis-cache and a process-wide instance.
 */
export class PageCache {
  readonly lru: PageLru;
  private readonly now: () => number;
  /** Tag → until when pages carrying it are not stored (a recent or future change seen by a lookup). */
  private readonly settles = new Map<string, number>();
  private failures = 0;
  private openUntil = 0;
  /** Tag lookups made (tests: the breaker skips them). */
  lookups = 0;

  constructor(private readonly options: PageCacheOptions) {
    this.lru = new PageLru(options.maxBytes);
    this.now = options.now ?? Date.now;
  }

  /** Remembers that pages carrying `tag` are not worth storing until `until`. Bounded: the oldest settle goes first. */
  private remember(tag: string, until: number): void {
    if ((this.settles.get(tag) ?? 0) >= until) return;
    this.settles.delete(tag);
    this.settles.set(tag, until);
    while (this.settles.size > MAX_SETTLES) this.settles.delete(this.settles.keys().next().value as string);
  }

  /** Whether one of `tags` is settling now (its pages would be dropped on the next lookup). */
  private settling(tags: readonly string[], now: number): boolean {
    let hit = false;
    for (const tag of tags) {
      const until = this.settles.get(tag);
      if (until === undefined) continue;
      if (until <= now) this.settles.delete(tag);
      else hit = true;
    }
    return hit;
  }

  private async tagTimes(tags: readonly string[]): Promise<(number | null)[] | null> {
    const now = this.now();
    if (now < this.openUntil) return null;
    this.lookups++;
    try {
      const times = await this.options.store.read(tags);
      this.failures = 0;
      return times;
    } catch (err) {
      this.failures++;
      if (this.failures >= BREAKER_FAILURES) {
        this.openUntil = now + BREAKER_OPEN_MS;
        this.failures = 0;
      }
      this.options.onError?.(err);
      return null;
    }
  }

  async get(key: string): Promise<{ value: unknown; lastModified: number; cacheControl?: unknown } | null> {
    const e = this.lru.get(key);
    if (!e) return null;
    const now = this.now();
    if (now - e.lastModified > PAGE_TAG_TTL_SECONDS * 1_000) {
      this.lru.delete(key);
      return null;
    }
    if (e.shared.length > 0) {
      // null: redis-cache unavailable or the breaker open — served as cached (fails open).
      const times = (await this.tagTimes(e.shared)) ?? [];
      let stale = false;
      times.forEach((t, i) => {
        if (t === null) return;
        const until = t + RENDER_MARGIN_MS;
        if (until >= e.lastModified) stale = true;
        if (until > now) this.remember(e.shared[i] as string, until);
      });
      if (stale) {
        this.lru.delete(key);
        return null;
      }
    }
    return {
      value: e.value,
      lastModified: e.lastModified,
      ...(e.cacheControl ? { cacheControl: e.cacheControl } : {}),
    };
  }

  async set(key: string, data: unknown, ctx?: CacheContext): Promise<void> {
    if (data === null || data === undefined) {
      this.lru.delete(key);
      return;
    }
    const tags = tagsOf(data, ctx);
    const shared = tags.filter(isSharedPageTag);
    const now = this.now();
    // A page the next lookup would drop is not stored (its tag is settling).
    if (this.settling(shared, now)) {
      this.lru.delete(key);
      return;
    }
    this.lru.set(key, {
      value: data,
      lastModified: now,
      tags,
      shared,
      cacheControl: ctx?.cacheControl,
      bytes: approximateBytes(data) + key.length * 2,
    });
  }

  /** `revalidateTag` in any instance: shared tags are marked on redis-cache (every instance), local copies dropped. */
  async revalidateTag(tags: string | readonly string[]): Promise<void> {
    const list = typeof tags === 'string' ? [tags] : [...tags];
    this.lru.deleteTagged(new Set(list));
    await markPageTagsChanged(this.options.store, list, this.now());
  }
}
