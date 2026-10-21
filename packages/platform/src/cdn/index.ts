import type { Logger } from '../logger';

/**
 * CDN cache purge (S7-06, ADR 0012 #5). The website API's answers carry `Cache-Tag` headers at the origin; when what
 * they show changes, a worker job purges those tags at the edge. Cloudflare strips `Cache-Tag` before answering a
 * client and purges by tag on every plan (100 tags per request; Free 5 / min, Pro 5 / s, Business 10 / s per account,
 * bursts of 25–50). Purging is an accelerator: answers live at most their `s-maxage` anyway, so a failed purge only
 * delays freshness by that TTL.
 *
 * Never call it inside a database transaction (CLAUDE.md rule 6): the job calls it after its reads.
 */
export interface CdnPurger {
  /** Purges these tags (any count: sent in requests of at most `CDN_PURGE_MAX_TAGS`, paced). */
  purgeTags(tags: readonly string[], options?: { signal?: AbortSignal }): Promise<void>;
}

/** Tags per purge request (Cloudflare: 100 operations per request on every plan). */
export const CDN_PURGE_MAX_TAGS = 100;
/** Cloudflare: printable ASCII, no spaces or commas, at most 1,024 characters in a purge call. */
const TAG = /^[\x21-\x2b\x2d-\x7e]{1,1024}$/;

export class CdnPurgeError extends Error {
  override readonly name = 'CdnPurgeError';
  constructor(
    message: string,
    /** HTTP status of the purge API (0: no answer — network error or timeout). */
    readonly status: number,
    /** Seconds the API asked to wait (429), if it said. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export interface CloudflarePurgerOptions {
  zoneId: string;
  /** API token with the zone's "Cache Purge" permission only. Never logged. */
  apiToken: string;
  /**
   * Time each purge request holds the caller after it is sent (the account's rate limit is shared by every zone of
   * the plan): 250 ms keeps Pro (5 / s) and up comfortable; Free needs 12,000. The caller (a job running one at a
   * time across the pool) holds its global slot meanwhile, so the pace holds across processes.
   */
  minIntervalMs?: number;
  timeoutMs?: number;
  logger?: Logger;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const API = 'https://api.cloudflare.com/client/v4';
const ZONE_ID = /^[a-f0-9]{32}$/;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Valid, distinct tags; anything else is a caller bug. */
function checkedTags(tags: readonly string[]): string[] {
  const unique = [...new Set(tags)];
  for (const tag of unique) if (!TAG.test(tag)) throw new TypeError(`cdn: invalid cache tag ${JSON.stringify(tag)}`);
  return unique;
}

/** Cloudflare's purge-by-tag API (`POST /zones/{zone}/purge_cache` with `{ tags }`), one request per 100 tags. */
export function createCloudflarePurger(options: CloudflarePurgerOptions): CdnPurger {
  if (!ZONE_ID.test(options.zoneId)) throw new TypeError('cdn: CLOUDFLARE_ZONE_ID must be a 32-character hex id');
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${options.endpoint ?? API}/zones/${options.zoneId}/purge_cache`;
  const minInterval = options.minIntervalMs ?? 250;
  return {
    async purgeTags(tags, { signal } = {}) {
      for (const batch of chunks(checkedTags(tags), CDN_PURGE_MAX_TAGS)) {
        let res: Response;
        try {
          res = await doFetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${options.apiToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ tags: batch }),
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)])
              : AbortSignal.timeout(options.timeoutMs ?? 10_000),
          });
        } catch (err) {
          throw new CdnPurgeError(`cdn purge failed: ${err instanceof Error ? err.name : 'error'}`, 0);
        }
        let body: { success?: unknown; errors?: unknown } = {};
        try {
          body = (await res.json()) as typeof body;
        } catch {
          // A non-JSON answer: judged by the status alone.
        }
        if (res.ok && body.success === true) {
          if (minInterval > 0) await sleep(minInterval);
          continue;
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const codes = Array.isArray(body.errors)
          ? body.errors.map((e) => (e as { code?: unknown }).code).filter((c) => c !== undefined)
          : [];
        options.logger?.warn({ status: res.status, codes, tags: batch.length }, 'cdn purge refused');
        throw new CdnPurgeError(
          `cdn purge refused (${res.status})`,
          res.status,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        );
      }
    },
  };
}

/** Tests and local runs: records every purge call (each call's tags, in order). */
export interface MemoryCdn extends CdnPurger {
  readonly purged: string[][];
  /** Every tag purged so far. */
  tags(): Set<string>;
}

export function createMemoryCdn(): MemoryCdn {
  const purged: string[][] = [];
  return {
    purged,
    tags: () => new Set(purged.flat()),
    async purgeTags(tags) {
      for (const batch of chunks(checkedTags(tags), CDN_PURGE_MAX_TAGS)) purged.push(batch);
    },
  };
}

let current: CdnPurger | null = null;

/** Sets the process-wide purger (worker boot; a memory one in tests). null: no edge cache to purge. */
export function configureCdn(next: CdnPurger | null): void {
  current = next;
}

/** The configured purger, or null when this environment has no edge cache (local, CI, edge cache off). */
export function cdnPurger(): CdnPurger | null {
  return current;
}
