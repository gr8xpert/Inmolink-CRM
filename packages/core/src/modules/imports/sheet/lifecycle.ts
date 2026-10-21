import { SHEET_URL_PREFIX } from '@inmolink/contracts';
import { withSystem, withTenant } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { readCheckpoint, writeCheckpoint } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import { SHEETS } from '../config';
import * as repo from '../repo';
import { sheetFileId, sheetKey } from './connector';

/**
 * Uploaded sheets do not outlive their use (S7-F1, S6 security review M1: they may hold owner data). Three ways out,
 * every one through the storage adapter and outside any database transaction:
 *
 * 1. **Released** — deleting a sheet connection, or a new upload replacing its file, emits `imports.sheet.released`
 *    in that transaction; the subscription's job (`imports.deleteSheet`) deletes the file after the commit unless
 *    another connection of the agency still points at it.
 * 2. **Idle** — the daily sweep (`imports.sweepSheets`) deletes a file whose connections have not run, been created
 *    or changed for `SHEETS.RETENTION_DAYS` (a queued or running run keeps it). Running such a connection again fails
 *    with `FEED_FETCH_FAILED`; the agency uploads the file again.
 * 3. **Orphaned** — a file no connection points to (an upload never imported, a failed release, an offboarded
 *    agency's files) is deleted by the sweep once it is `SHEETS.UNUSED_GRACE_MS` old. Offboarding and erasure call
 *    `deleteAgencySheets` for the whole prefix at once.
 *
 * Race-free with "start the import": the release job and the sweep decide under the files' advisory locks
 * (`repo.lockSheets`) and record the decision (`feed_sheet_releases`) before the storage delete, after the commit;
 * `startSheetImport` takes the same lock and refuses a released file.
 *
 * Idempotent: deleting a missing object is a no-op, and every decision is read again from the database.
 */

/** The file a sheet connection's url names, or null for any other connection. */
export function connectionSheet(connector: string, url: string): string | null {
  return connector === 'sheet-mapped' ? sheetFileId(url) : null;
}

/** Storage deletes in flight at once (one page of the sweep or of an agency purge). */
const DELETE_CONCURRENCY = 8;

async function deleteAll(keys: readonly string[]): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++] as string;
      await storage().delete('private', key);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, keys.length) }, worker));
}

/** `imports.deleteSheet`: the file of a released sheet, unless a connection of its agency still uses it. */
export async function deleteReleasedSheet(p: { agencyId: string; fileId: string }): Promise<{ deleted: boolean }> {
  const fileId = p.fileId.toLowerCase();
  const release = await withTenant({ agencyId: p.agencyId }, async (tx) => {
    await repo.lockSheets(tx, [fileId]);
    if (await repo.sheetInUse(tx, `${SHEET_URL_PREFIX}${fileId}`)) return false;
    await repo.insertSheetReleases(tx, [{ agencyId: p.agencyId, fileId }]);
    return true;
  });
  if (!release) return { deleted: false };
  await storage().delete('private', sheetKey(p.agencyId, fileId));
  return { deleted: true };
}

const KEY = /^imports\/sheets\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/;
const CHECKPOINT = 'imports.sweepSheets';

export interface SheetSweepResult {
  scanned: number;
  deleted: number;
  /** Deleted because no connection points at them (subset of `deleted`). */
  orphaned: number;
  /** The listing reached the end of the prefix: the next run starts from the beginning again. */
  end: boolean;
  /** Release tombstones pruned. */
  pruned: number;
}

interface Candidate {
  key: string;
  agencyId: string;
  fileId: string;
  url: string;
}

/** Of these candidates, the ones to delete now: idle past the retention, or no connection at all. */
function deletable(
  candidates: readonly Candidate[],
  activity: Map<string, Date>,
  idleBefore: number,
): (Candidate & { orphan: boolean })[] {
  return candidates.flatMap((c) => {
    const activeAt = activity.get(`${c.agencyId}|${c.url}`);
    if (activeAt && activeAt.getTime() > idleBefore) return [];
    return [{ ...c, orphan: !activeAt }];
  });
}

/**
 * `imports.sweepSheets` (daily): lists `imports/sheets/` a page at a time from where the last run stopped (a
 * `job_checkpoints` row; cleared when the listing reaches the end, so the next run starts over), reads the page's
 * connections' activity in one statement (`withSystem`: every agency's files), then re-checks the files to delete
 * under their locks, records them released and deletes them after that commit. Objects younger than the grace period
 * are never looked up. At most `maxPages` pages per run; `signal` is checked between pages, a page is finished.
 */
export async function sweepSheets(
  opts: { signal?: AbortSignal; maxPages?: number; pageSize?: number } = {},
): Promise<SheetSweepResult> {
  const now = clock.now().getTime();
  const youngest = now - SHEETS.UNUSED_GRACE_MS;
  const idleBefore = now - SHEETS.RETENTION_DAYS * 24 * 3_600_000;
  const result: SheetSweepResult = { scanned: 0, deleted: 0, orphaned: 0, end: false, pruned: 0 };
  let last = await withSystem(CHECKPOINT, (tx) => readCheckpoint(tx, CHECKPOINT));
  const maxPages = opts.maxPages ?? SHEETS.MAX_PAGES;
  for (let page = 0; page < maxPages && !opts.signal?.aborted; page++) {
    const listed = await storage().list('private', SHEETS.PREFIX, {
      limit: opts.pageSize ?? SHEETS.LIST_PAGE,
      ...(last ? { startAfter: last } : {}),
    });
    result.scanned += listed.objects.length;
    const candidates = listed.objects.flatMap((o): Candidate[] => {
      const m = KEY.exec(o.key);
      if (!m || o.lastModified.getTime() > youngest) return [];
      const fileId = m[2] as string;
      return [{ key: o.key, agencyId: m[1] as string, fileId, url: `${SHEET_URL_PREFIX}${fileId}` }];
    });
    const first = deletable(
      candidates,
      await withSystem(CHECKPOINT, (tx) => repo.sheetActivity(tx, candidates)),
      idleBefore,
    );
    // Decide again under the files' locks (a connection may have started using one meanwhile), record the releases.
    const doomed =
      first.length === 0
        ? []
        : await withSystem(CHECKPOINT, async (tx) => {
            await repo.lockSheets(
              tx,
              first.map((c) => c.fileId),
            );
            const still = deletable(first, await repo.sheetActivity(tx, first), idleBefore);
            await repo.insertSheetReleases(
              tx,
              still.map((c) => ({ agencyId: c.agencyId, fileId: c.fileId })),
            );
            return still;
          });
    await deleteAll(doomed.map((c) => c.key));
    result.deleted += doomed.length;
    result.orphaned += doomed.filter((c) => c.orphan).length;
    last = listed.objects.at(-1)?.key ?? last;
    if (!listed.next) {
      result.end = true;
      break;
    }
  }
  // Cut short: the next run resumes after the last key; at the end it wraps to the start.
  await withSystem(CHECKPOINT, (tx) => writeCheckpoint(tx, CHECKPOINT, result.end ? null : (last ?? null)));
  const pruneBefore = new Date(now - SHEETS.RELEASE_RETENTION_DAYS * 24 * 3_600_000);
  for (let i = 0; i < SHEETS.MAX_PAGES && !opts.signal?.aborted; i++) {
    const n = await withSystem(CHECKPOINT, (tx) => repo.pruneSheetReleases(tx, pruneBefore, SHEETS.PRUNE_BATCH));
    result.pruned += n;
    if (n < SHEETS.PRUNE_BATCH) break;
  }
  return result;
}

/**
 * Every uploaded sheet of an agency (`imports/sheets/<agency>/`), for offboarding and tenant erasure (S7-F1). Call it
 * after the transaction that removed the agency's connections committed (storage I/O, never inside one). Lists from
 * the start each page (what was deleted is not listed again); `more` says the bound was hit and the caller runs it
 * again. Idempotent.
 */
export async function deleteAgencySheets(
  agencyId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ deleted: number; more: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(agencyId)) throw new Error('deleteAgencySheets: not an agency id');
  const prefix = `${SHEETS.PREFIX}${agencyId.toLowerCase()}/`;
  let deleted = 0;
  let more = false;
  for (let page = 0; page < SHEETS.MAX_PAGES && !opts.signal?.aborted; page++) {
    const listed = await storage().list('private', prefix, { limit: SHEETS.LIST_PAGE });
    await deleteAll(listed.objects.map((o) => o.key));
    deleted += listed.objects.length;
    more = Boolean(listed.next);
    if (!more) break;
  }
  return { deleted, more };
}
