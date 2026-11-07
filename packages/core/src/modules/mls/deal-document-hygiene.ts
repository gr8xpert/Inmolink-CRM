import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { readCheckpoint, writeCheckpoint } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import { DEAL_DOCUMENTS_PREFIX, dealDocumentKey } from './deal-documents';
import * as repo from './deal-documents-repo';

/**
 * Deal document hygiene (R2-04b, pool `maintenance`; the development documents' shape, S4-F4):
 *
 * - `deleteDealDocumentObject` (one per `mls.dealDocument.removed`): deletes the removed document's object once no live
 *   row names it (both copies are marked removed in the removing statement). A failed delete throws and the job is
 *   retried with backoff; deleting a missing object succeeds, so a repeated run writes the same truth.
 * - `sweepOrphanDealDocuments` (every hour): `deal-documents/` objects older than an hour that no live row names — a
 *   crash between store and record, a lost delete job — are deleted. One query per listed page; a run stops at its page
 *   cap and saves the last key it listed (`job_checkpoints`), the next run resumes after it and one that reaches the end
 *   clears it.
 */

/** An object this young may still be between "stored" and "recorded" in an upload: leave it alone. */
export const DEAL_DOCUMENT_ORPHAN_MIN_AGE_MS = 60 * 60_000;
const LIST_PAGE = 500;
/** Pages per sweep run (100k objects): bounds one run; the next run continues. */
export const DEAL_DOCUMENT_SWEEP_MAX_PAGES = 200;
const STORAGE_CONCURRENCY = 16;

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export async function deleteDealDocumentObject(p: {
  dealId: string;
  documentId: string;
}): Promise<{ deleted: boolean }> {
  const key = dealDocumentKey(p.dealId, p.documentId);
  const live = await withSystem('mls.deleteDealDocumentObject: is the object still named', (tx) =>
    repo.liveDocumentKeys(tx, [key]),
  );
  if (live.has(key)) return { deleted: false };
  await storage().delete('private', key);
  return { deleted: true };
}

export async function sweepOrphanDealDocuments(
  p: { pageSize?: number | undefined; maxPages?: number | undefined },
  signal: AbortSignal,
): Promise<{ scanned: number; deleted: number; end: boolean }> {
  const name = 'mls.sweepOrphanDealDocuments';
  const cutoff = clock.now().getTime() - DEAL_DOCUMENT_ORPHAN_MIN_AGE_MS;
  let scanned = 0;
  let deleted = 0;
  let last = await withSystem(name, (tx) => readCheckpoint(tx, name));
  let end = false;
  for (let page = 0; page < (p.maxPages ?? DEAL_DOCUMENT_SWEEP_MAX_PAGES) && !signal.aborted; page++) {
    const listed = await storage().list('private', DEAL_DOCUMENTS_PREFIX, {
      limit: p.pageSize ?? LIST_PAGE,
      startAfter: last,
    });
    scanned += listed.objects.length;
    const old = listed.objects.filter((o) => o.lastModified.getTime() <= cutoff).map((o) => o.key);
    const known = await withSystem(name, (tx) => repo.liveDocumentKeys(tx, old));
    const garbage = old.filter((k) => !known.has(k));
    await eachLimit(garbage, STORAGE_CONCURRENCY, (k) => storage().delete('private', k));
    deleted += garbage.length;
    last = listed.objects.at(-1)?.key ?? last;
    if (!listed.next) {
      end = true;
      break;
    }
  }
  // Cut short: the next run resumes after the last key; at the end it wraps to the start.
  await withSystem(name, (tx) => writeCheckpoint(tx, name, end ? null : (last ?? null)));
  return { scanned, deleted, end };
}
