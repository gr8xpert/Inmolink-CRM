/**
 * S16-F1: the owner set behind every portal search, shared on redis-cache. The skip scan over the search documents
 * (`repo.searchDocOwners`, one index probe per owner: ~80 ms at scale) runs in the search worker
 * (`search.refreshDocOwners`, every `DOC_OWNERS_REFRESH_MS`) and is stored as one global value; every public instance
 * reads that (one MGET) instead of scanning itself.
 *
 * At most one scan per `DOC_OWNERS_CLAIM_MS` across all processes: the worker and a request that finds the value
 * missing share one claim (`SET NX PX`; released when the scan fails, so a retry runs at once). A request that loses
 * the claim gets `null` (the caller answers without the set — the portal shows the listed agencies by name); with
 * redis-cache down the request scans itself (the S15 behaviour: slower, still right).
 *
 * Missing means: never written, evicted, older than `DOC_OWNERS_MAX_AGE_MS` (a stalled worker never keeps an old set
 * looking valid), or scanned before a new owner appeared. The read-model builds call `noteDocOwner` after writing an
 * agency's documents: an agency that owns a PUBLIC document but is not in the set marks it stale (a time stamp — a
 * scan that started before it is not used either), so a new owner never waits for the next scan to be hidden.
 * S17-F3: the mark also releases the scan claim — the set it makes stale is the one the claim protects, so without the
 * release every portal search would answer without the set (`null`) until the claim lapsed (up to `DOC_OWNERS_CLAIM_MS`)
 * and the worker's next run would skip; with it the next reader scans at once. New owners are rare (one release each).
 *
 * The scan runs as `app_public` like the portal's own reads, so the set holds the owners of PUBLIC documents only.
 */
import { withPublicRead } from '@inmolink/db';
import { cache, cacheKey } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import * as repo from './repo';

/** The worker refreshes the set this often (its schedule). */
export const DOC_OWNERS_REFRESH_MS = 60_000;
/** One scan per window across every process; a little under the schedule so a late-picked run is not skipped. */
export const DOC_OWNERS_CLAIM_MS = 58_000;
/** A set older than this (one missed run and some slack) reads as missing. */
export const DOC_OWNERS_MAX_AGE_MS = DOC_OWNERS_REFRESH_MS + 15_000;
/** Redis keeps the set (and the stale mark) a little past its useful age. */
const DOC_OWNERS_TTL_SECONDS = 90;
/** The worker's in-process copy of the set (`noteDocOwner`), so a burst of builds does not re-read it each batch. */
const KNOWN_TTL_MS = 5_000;

const OWNERS_KEY = cacheKey({ v: 2, module: 'search', entity: 'doc-owners', scope: 'global' });
const STALE_KEY = cacheKey({ v: 1, module: 'search', entity: 'doc-owners-stale', scope: 'global' });
const CLAIM_KEY = cacheKey({ v: 1, module: 'search', entity: 'doc-owners-scan', scope: 'global' });

let log: Logger | undefined;
const logger = () => {
  log ??= createLogger({ service: 'search' });
  return log;
};

/** The agencies owning a PUBLIC search document, and when the scan that read them started (epoch ms). */
export interface DocOwners {
  owners: string[];
  at: number;
}

/** The stored set, unless it is missing, too old, or older than the latest stale mark. */
function decode(stored: unknown, staleAt: unknown): DocOwners | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const { owners, at } = stored as Partial<DocOwners>;
  if (!Array.isArray(owners) || typeof at !== 'number') return null;
  if (clock.nowMs() - at > DOC_OWNERS_MAX_AGE_MS) return null;
  if (typeof staleAt === 'number' && staleAt >= at) return null;
  return { owners, at };
}

async function readStored(): Promise<DocOwners | null> {
  const [stored, staleAt] = await cache.peekMany([OWNERS_KEY, STALE_KEY]);
  return decode(stored, staleAt);
}

/**
 * Scans and stores under a claim this caller holds (a failed store is logged: the scan still answers). Dated by the
 * scan's start, so an owner marked during the scan makes it stale. A failed scan releases the claim.
 */
async function scanAndStore(): Promise<DocOwners> {
  const at = clock.nowMs();
  let owners: string[];
  try {
    owners = await withPublicRead((tx) => repo.searchDocOwners(tx));
  } catch (err) {
    await cache.release(CLAIM_KEY).catch(() => undefined);
    throw err;
  }
  const value: DocOwners = { owners, at };
  try {
    await cache.set(OWNERS_KEY, value, { ttlSeconds: DOC_OWNERS_TTL_SECONDS });
  } catch (err) {
    logger().warn({ err }, 'search: storing the document owners failed');
  }
  return value;
}

/**
 * `search.refreshDocOwners` (worker): scans and stores the set unless a scan ran within `DOC_OWNERS_CLAIM_MS` (a
 * request's fallback, another worker). Throws when redis-cache is down or the scan fails (the job retries).
 */
export async function refreshDocOwners(): Promise<{ owners: number } | { skipped: true }> {
  if (!(await cache.claim(CLAIM_KEY, DOC_OWNERS_CLAIM_MS))) return { skipped: true };
  return { owners: (await scanAndStore()).owners.length };
}

/**
 * The shared owner set (request path, one MGET). Missing: this caller scans when it wins the claim (or redis-cache is
 * down), else `null` — another process is scanning or just did and its value is not readable yet.
 */
export async function sharedDocOwners(): Promise<DocOwners | null> {
  const stored = await readStored();
  if (stored) return stored;
  let claimed: boolean;
  try {
    claimed = await cache.claim(CLAIM_KEY, DOC_OWNERS_CLAIM_MS);
  } catch (err) {
    logger().warn({ err }, 'search: redis-cache unavailable; scanning the document owners in this process');
    claimed = true;
  }
  return claimed ? scanAndStore() : null;
}

let known: { at: number; owners: Set<string>; until: number } | undefined;

/**
 * S17-F3 review: the stored set as written, whatever its age or stale mark (membership only: "is this owner new?"),
 * and the latest stale mark. A set already marked stale still lists every owner it had.
 */
async function readRaw(): Promise<{ set: DocOwners | null; staleAt: number | null }> {
  const [stored, staleAt] = await cache.peekMany([OWNERS_KEY, STALE_KEY]);
  const v = stored as Partial<DocOwners> | null | undefined;
  const set = v && Array.isArray(v.owners) && typeof v.at === 'number' ? { owners: v.owners, at: v.at } : null;
  return { set, staleAt: typeof staleAt === 'number' ? staleAt : null };
}

/**
 * After a build wrote `agencyId`'s documents: if the agency owns a PUBLIC document the shared set does not list, mark
 * the set stale (the next read scans, under the claim). In the set (the usual case): no statement, at most one MGET
 * per `KNOWN_TTL_MS`. S16 review: throws (logged) when redis-cache or the probe fails, so the build job retries — a
 * missed mark would leave the new owner unhidden until the next scan. The caller's documents are already written: the
 * retry only marks again (the jobs call it on every retry, even with nothing new to write).
 */
export async function noteDocOwner(agencyId: string): Promise<boolean> {
  try {
    const now = clock.nowMs();
    if (!known || known.until <= now) {
      // S17-F3 review: membership against the stored set even once it is marked stale — an owner it lists is never
      // "new", so a burst of builds after one mark neither marks again nor releases the claim again
      const { set } = await readRaw();
      known = set ? { at: set.at, owners: new Set(set.owners), until: now + KNOWN_TTL_MS } : undefined;
    }
    if (known?.owners.has(agencyId)) return false;
    if (!(await withPublicRead((tx) => repo.ownsSearchDoc(tx, agencyId)))) return false;
    const { set, staleAt } = await readRaw();
    // a mark already newer than the stored scan: that mark released the claim, and the rescan it let in sees this owner
    // too (or is dated before this mark and so not used) — mark again, never release twice per scan
    const pending = set !== null && staleAt !== null && staleAt >= set.at;
    await cache.set(STALE_KEY, clock.nowMs(), { ttlSeconds: DOC_OWNERS_TTL_SECONDS });
    // S17-F3: the claimed scan (if any) read the set this mark makes stale; the next reader rescans now
    if (!pending) await cache.release(CLAIM_KEY);
    known = undefined;
    return true;
  } catch (err) {
    known = undefined;
    logger().warn({ err, agencyId }, 'search: checking a new document owner failed; the build retries');
    throw err;
  }
}

/** Tests: drops the worker's in-process copy. */
export function resetDocOwnersCopy(): void {
  known = undefined;
}
