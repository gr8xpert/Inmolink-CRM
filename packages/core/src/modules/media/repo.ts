/**
 * media queries (PATTERNS §5). Takes `tx`, selects only the columns it needs. Queries only
 * `@inmolink/db/schema/media` — other modules' tables fail `pnpm check:boundaries`. Request work runs as
 * `app_user` (RLS: own listing media, plus shared listings' non-document media; `media_objects` read-only);
 * the worker's reference counting runs through `withSystem()`.
 */
import type { Tx } from '@inmolink/db';
import { mediaObjects, propertyMedia } from '@inmolink/db/schema/media';
import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';

export type MediaRow = Pick<
  typeof propertyMedia.$inferSelect,
  'id' | 'sha256' | 'kind' | 'position' | 'isCover' | 'altText' | 'createdAt'
>;
export type MediaInsert = typeof propertyMedia.$inferInsert;
export type ObjectInsert = Pick<typeof mediaObjects.$inferInsert, 'sha256' | 'sizeBytes' | 'contentType'>;

const mediaColumns = {
  id: propertyMedia.id,
  sha256: propertyMedia.sha256,
  kind: propertyMedia.kind,
  position: propertyMedia.position,
  isCover: propertyMedia.isCover,
  altText: propertyMedia.altText,
  createdAt: propertyMedia.createdAt,
};

/** Stored objects among `hashes` (one PK probe each), and whether their files can be trusted to stay. */
export async function storedObjects(tx: Tx, hashes: string[]): Promise<Map<string, { trusted: boolean }>> {
  if (hashes.length === 0) return new Map();
  const rows = await tx
    .select({ sha256: mediaObjects.sha256, deleteAfter: mediaObjects.deleteAfter, failedAt: mediaObjects.failedAt })
    .from(mediaObjects)
    .where(inArray(mediaObjects.sha256, hashes));
  // Pending deletion, or processing failed: its files may be gone — never skip the upload for it.
  return new Map(rows.map((r) => [r.sha256, { trusted: r.deleteAfter === null && r.failedAt === null }]));
}

/** A listing's media in order (≤ MEDIA_PER_LISTING_MAX rows; `property_media_property_idx`). */
export async function listForListing(tx: Tx, propertyId: string): Promise<MediaRow[]> {
  return tx
    .select(mediaColumns)
    .from(propertyMedia)
    .where(eq(propertyMedia.propertyId, propertyId))
    .orderBy(asc(propertyMedia.position), asc(propertyMedia.id));
}

/**
 * Opens a gap of `count` positions at `from` (positions stay 0…n-1 without holes) and, when a new cover comes,
 * takes the cover off the old one — one statement.
 */
export async function makeRoom(
  tx: Tx,
  propertyId: string,
  q: { from: number; count: number; clearCover: boolean },
): Promise<void> {
  await tx.execute(sql`
    update property_media
       set position = case when position >= ${q.from} then position + ${q.count} else position end,
           is_cover = is_cover and not ${q.clearCover},
           updated_at = now()
     where property_id = ${propertyId} and (position >= ${q.from} or (${q.clearCover} and is_cover))`);
}

/** Closes the hole a removed row left at `removed`. */
export async function closeGap(tx: Tx, propertyId: string, removed: number): Promise<void> {
  await tx
    .update(propertyMedia)
    .set({ position: sql`${propertyMedia.position} - 1`, updatedAt: sql`now()` })
    .where(and(eq(propertyMedia.propertyId, propertyId), gt(propertyMedia.position, removed)));
}

/** A listing with images always has a cover: without one, its first image becomes it. */
export async function ensureCover(tx: Tx, propertyId: string): Promise<void> {
  await tx.execute(sql`
    update property_media set is_cover = true, updated_at = now()
     where id = (select id from property_media
                  where property_id = ${propertyId} and kind = 'IMAGE'
                  order by position, id limit 1)
       and not exists (select 1 from property_media where property_id = ${propertyId} and is_cover)`);
}

export async function insertMedia(tx: Tx, rows: MediaInsert[]): Promise<void> {
  if (rows.length > 0) await tx.insert(propertyMedia).values(rows);
}

/** Removes one media row of the listing; null when it has no such row. */
export async function deleteMedia(
  tx: Tx,
  propertyId: string,
  id: string,
): Promise<{ sha256: string; position: number; isCover: boolean } | null> {
  const [row] = await tx
    .delete(propertyMedia)
    .where(and(eq(propertyMedia.propertyId, propertyId), eq(propertyMedia.id, id)))
    .returning({ sha256: propertyMedia.sha256, position: propertyMedia.position, isCover: propertyMedia.isCover });
  return row ?? null;
}

// --- worker (withSystem) -----------------------------------------------------------------------------------

/** Records verified uploads; an object recorded already keeps its row. */
export async function insertObjects(tx: Tx, rows: ObjectInsert[]): Promise<void> {
  if (rows.length === 0) return;
  // Hash order, like the locks in `recount`: two jobs inserting the same new objects cannot deadlock.
  const sorted = [...rows].sort((x, y) => (x.sha256 < y.sha256 ? -1 : 1));
  await tx.insert(mediaObjects).values(sorted).onConflictDoNothing({ target: mediaObjects.sha256 });
}

/**
 * Sets each object's `refcount` to the number of listing media rows using it, across every agency, and
 * schedules an unreferenced object for deletion at `deleteAt` (an earlier schedule stays). Idempotent: a
 * repeated or late run writes the same truth. The rows are locked first (hash order: no deadlocks), so the
 * count — a new statement, a new snapshot — sees every change committed before the lock was granted; a later
 * change emits its own event and recounts again.
 */
export async function recount(tx: Tx, hashes: string[], deleteAt: Date): Promise<number> {
  if (hashes.length === 0) return 0;
  const sorted = [...new Set(hashes)].sort();
  const list = sql.join(
    sorted.map((h) => sql`${h}`),
    sql`, `,
  );
  await tx.execute(sql`select sha256 from media_objects where sha256 in (${list}) order by sha256 for update`);
  const res = await tx.execute(sql`
    update media_objects o
       set refcount = c.n,
           delete_after = case when c.n = 0 then coalesce(o.delete_after, ${deleteAt.toISOString()}::timestamptz) end,
           updated_at = now()
      from (select h.sha256, (select count(*) from property_media m where m.sha256 = h.sha256)::int as n
              from unnest(array[${list}]::char(64)[]) as h(sha256)) c
     where o.sha256 = c.sha256`);
  return res.rowCount ?? 0;
}

// --- processing and cleanup (S3-04, withSystem) --------------------------------------------------------------

export type ObjectState = { contentType: string; pipeline: number | null; variantsReady: number };

/** What the processor needs to know about one object; null when it is not recorded (or deleted). */
export async function objectState(tx: Tx, sha256: string): Promise<ObjectState | null> {
  const [row] = await tx
    .select({
      contentType: mediaObjects.contentType,
      pipeline: mediaObjects.pipeline,
      variantsReady: mediaObjects.variantsReady,
    })
    .from(mediaObjects)
    .where(eq(mediaObjects.sha256, sha256));
  return row ?? null;
}

/**
 * Records a processing result: `bits` of `pipeline` exist now. Same pipeline → the bits are added; a newer one
 * replaces the older pipeline's bits (its variants are no longer the ones read). Width, height and pHash come
 * from the master (always the same for one object). Returns false when the object is not recorded any more.
 */
export async function markProcessed(
  tx: Tx,
  sha256: string,
  r: { pipeline: number; bits: number; width: number; height: number; phash: bigint },
): Promise<boolean> {
  const res = await tx.execute(sql`
    update media_objects
       set variants_ready = case when pipeline = ${r.pipeline} then variants_ready | ${r.bits} else ${r.bits} end,
           pipeline = ${r.pipeline},
           width = ${r.width}, height = ${r.height}, phash = ${r.phash.toString()}::bigint,
           failed_at = null, updated_at = now()
     where sha256 = ${sha256} and (pipeline is null or pipeline <= ${r.pipeline})`);
  return (res.rowCount ?? 0) > 0 || (await objectState(tx, sha256)) !== null;
}

/**
 * Processing an unprocessed object failed for good. Nothing uses it → its record goes (the next check asks for
 * an upload); listings use it → it is marked failed, which the check treats like a pending deletion (asks for
 * a fresh upload; a successful run clears the mark).
 */
export async function failUnprocessed(tx: Tx, sha256: string): Promise<void> {
  await tx.execute(sql`
    delete from media_objects o
     where o.sha256 = ${sha256} and o.pipeline is null
       and not exists (select 1 from property_media m where m.sha256 = o.sha256)`);
  await tx.execute(sql`
    update media_objects set failed_at = now(), updated_at = now()
     where sha256 = ${sha256} and pipeline is null`);
}

const hashList = (hashes: string[]) =>
  sql.join(
    hashes.map((h) => sql`${h}`),
    sql`, `,
  );

/**
 * Orphan cleanup, step 1: due objects (`delete_after` passed; `media_objects_delete_after_idx`), locked (rows
 * another run holds are skipped), then counted again from `property_media` — never trusting `refcount` or
 * `delete_after` alone (S3-03 Decisions). Referenced ones get their true count back and lose the schedule;
 * the unreferenced ones are returned, still recorded and still due, for their files to be deleted.
 */
export async function claimDueObjects(
  tx: Tx,
  now: Date,
  limit: number,
): Promise<{ unreferenced: string[]; kept: number }> {
  const due = await tx.execute<{ sha256: string }>(sql`
    select sha256 from media_objects
     where delete_after <= ${now.toISOString()}::timestamptz
     order by delete_after limit ${limit}
       for update skip locked`);
  const hashes = due.rows.map((r) => r.sha256);
  if (hashes.length === 0) return { unreferenced: [], kept: 0 };
  // A fresh statement after the locks: it sees every reference committed before them.
  const kept = await tx.execute<{ sha256: string }>(sql`
    update media_objects o
       set refcount = c.n, delete_after = null, updated_at = now()
      from (select m.sha256, count(*)::int as n from property_media m
             where m.sha256 in (${hashList(hashes)}) group by m.sha256) c
     where o.sha256 = c.sha256
    returning o.sha256`);
  const keptSet = new Set(kept.rows.map((r) => r.sha256));
  return { unreferenced: hashes.filter((h) => !keptSet.has(h)), kept: keptSet.size };
}

/**
 * Orphan cleanup, step 2 (after the files are gone): deletes the records still due and unreferenced. One that a
 * listing started using meanwhile (it came with a fresh upload: a pending deletion is never trusted) lost its
 * files, so it goes back to unprocessed for the reconciler; returns how many did.
 */
export async function deleteUnreferenced(tx: Tx, hashes: string[], now: Date): Promise<number> {
  if (hashes.length === 0) return 0;
  const list = hashList(hashes);
  await tx.execute(sql`select sha256 from media_objects where sha256 in (${list}) order by sha256 for update`);
  await tx.execute(sql`
    delete from media_objects o
     where o.sha256 in (${list}) and o.delete_after <= ${now.toISOString()}::timestamptz
       and not exists (select 1 from property_media m where m.sha256 = o.sha256)`);
  const reset = await tx.execute(sql`
    update media_objects
       set pipeline = null, variants_ready = 0, failed_at = null, updated_at = now()
     where sha256 in (${list}) and pipeline is not null`);
  return reset.rowCount ?? 0;
}

/**
 * Which of these uploaded originals must stay: recorded and waiting to be processed, or not recorded yet but
 * already used by a listing (its sync is behind). Every other original is garbage.
 */
export async function originalsToKeep(tx: Tx, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const res = await tx.execute<{ sha256: string }>(sql`
    select h.sha256 from unnest(array[${hashList(hashes)}]::char(64)[]) as h(sha256)
      left join media_objects o on o.sha256 = h.sha256
     where (o.sha256 is not null and o.pipeline is null and o.failed_at is null)
        or (o.sha256 is null and exists (select 1 from property_media m where m.sha256 = h.sha256))`);
  return new Set(res.rows.map((r) => r.sha256));
}

/** Objects still unprocessed (not failed) since before `before`, oldest first (`media_objects_unprocessed_idx`). */
export async function staleUnprocessed(tx: Tx, before: Date, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ sha256: mediaObjects.sha256 })
    .from(mediaObjects)
    .where(and(isNull(mediaObjects.pipeline), isNull(mediaObjects.failedAt), lt(mediaObjects.createdAt, before)))
    .orderBy(asc(mediaObjects.createdAt))
    .limit(limit);
  return rows.map((r) => r.sha256);
}
