/**
 * media queries (PATTERNS §5). Takes `tx`, selects only the columns it needs. Queries only
 * `@inmolink/db/schema/media` — other modules' tables fail `pnpm check:boundaries`. Request work runs as
 * `app_user` (RLS: own listing media, plus shared listings' non-document media; `media_objects` read-only);
 * the worker's reference counting runs through `withMedia()` (app_media, S3-F4).
 */
import type { Tx } from '@inmolink/db';
import { listingDocuments, mediaObjects, propertyMedia } from '@inmolink/db/schema/media';
import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';

export type MediaRow = Pick<
  typeof propertyMedia.$inferSelect,
  'id' | 'sha256' | 'kind' | 'position' | 'isCover' | 'altText' | 'roomType' | 'createdAt' | 'videoProvider' | 'videoId'
>;
/** A listing's media row with its object's processing state (which variants exist), for preview URLs. */
export type MediaListRow = MediaRow & { pipeline: number | null; variantsReady: number };
export type MediaInsert = typeof propertyMedia.$inferInsert;
export type ObjectInsert = Pick<typeof mediaObjects.$inferInsert, 'sha256' | 'sizeBytes' | 'contentType'>;

const mediaColumns = {
  id: propertyMedia.id,
  sha256: propertyMedia.sha256,
  kind: propertyMedia.kind,
  position: propertyMedia.position,
  isCover: propertyMedia.isCover,
  altText: propertyMedia.altText,
  roomType: propertyMedia.roomType,
  createdAt: propertyMedia.createdAt,
  videoProvider: propertyMedia.videoProvider,
  videoId: propertyMedia.videoId,
};

export type StoredObject = { trusted: boolean; pipeline: number | null; variantsReady: number };

/**
 * Stored objects among `hashes` (one PK probe each), whether their files can be trusted to stay, and which
 * variants they have.
 */
export async function storedObjects(tx: Tx, hashes: string[]): Promise<Map<string, StoredObject>> {
  if (hashes.length === 0) return new Map();
  const rows = await tx
    .select({
      sha256: mediaObjects.sha256,
      deleteAfter: mediaObjects.deleteAfter,
      failedAt: mediaObjects.failedAt,
      pipeline: mediaObjects.pipeline,
      variantsReady: mediaObjects.variantsReady,
    })
    .from(mediaObjects)
    .where(inArray(mediaObjects.sha256, hashes));
  // Pending deletion, or processing failed: its files may be gone — never skip the upload for it.
  return new Map(
    rows.map((r) => [
      r.sha256,
      {
        trusted: r.deleteAfter === null && r.failedAt === null,
        pipeline: r.pipeline,
        variantsReady: r.variantsReady,
      },
    ]),
  );
}

/**
 * A listing's media in order with their objects' processing state (≤ MEDIA_PER_LISTING_MAX rows;
 * `property_media_property_idx`, then one PK probe per row). An object not recorded yet has no variants.
 */
export async function listForListing(tx: Tx, propertyId: string): Promise<MediaListRow[]> {
  const rows = await tx
    .select({ ...mediaColumns, pipeline: mediaObjects.pipeline, variantsReady: mediaObjects.variantsReady })
    .from(propertyMedia)
    .leftJoin(mediaObjects, eq(mediaObjects.sha256, propertyMedia.sha256))
    .where(eq(propertyMedia.propertyId, propertyId))
    .orderBy(asc(propertyMedia.position), asc(propertyMedia.id));
  return rows.map((r) => ({ ...r, variantsReady: r.variantsReady ?? 0 }));
}

/**
 * The pixel size of each photo (`IMAGE`) of a listing, null while its object is unprocessed (S3-08 quality score;
 * `property_media_property_idx`, then one PK probe per row, ≤ MEDIA_PER_LISTING_MAX rows).
 */
export async function imageSizes(tx: Tx, propertyId: string): Promise<({ width: number; height: number } | null)[]> {
  const rows = await tx
    .select({ width: mediaObjects.width, height: mediaObjects.height })
    .from(propertyMedia)
    .leftJoin(mediaObjects, eq(mediaObjects.sha256, propertyMedia.sha256))
    .where(and(eq(propertyMedia.propertyId, propertyId), eq(propertyMedia.kind, 'IMAGE')));
  return rows.map((r) => (r.width !== null && r.height !== null ? { width: r.width, height: r.height } : null));
}

/**
 * Changes one media row of the listing (S3-06). `cover: true` passes the cover to it: the old cover loses it
 * first (`property_media_cover_uq` allows one per listing); a row turned into a floor plan stops being the
 * cover (the service then hands it on). Null when the listing has no such row.
 */
export async function updateMedia(
  tx: Tx,
  propertyId: string,
  id: string,
  patch: { kind?: 'IMAGE' | 'FLOOR_PLAN'; altText?: string | null; roomType?: string | null; cover?: true },
): Promise<{ kind: string; isCover: boolean } | null> {
  if (patch.cover) {
    await tx
      .update(propertyMedia)
      .set({ isCover: false, updatedAt: sql`now()` })
      .where(and(eq(propertyMedia.propertyId, propertyId), eq(propertyMedia.isCover, true), ne(propertyMedia.id, id)));
  }
  const [row] = await tx
    .update(propertyMedia)
    .set({
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.altText !== undefined ? { altText: patch.altText } : {}),
      ...(patch.roomType !== undefined ? { roomType: patch.roomType } : {}),
      ...(patch.cover ? { isCover: true } : patch.kind === 'FLOOR_PLAN' ? { isCover: false } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(propertyMedia.propertyId, propertyId), eq(propertyMedia.id, id)))
    .returning({ kind: propertyMedia.kind, isCover: propertyMedia.isCover });
  return row ?? null;
}

/**
 * Sets every position of the listing's media from `ids` (index = position) in one statement; returns how many
 * rows it changed. The caller checked that `ids` are exactly the listing's media.
 */
export async function reorder(tx: Tx, propertyId: string, ids: string[]): Promise<number> {
  const list = sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  );
  const res = await tx.execute(sql`
    update property_media m
       set position = o.pos - 1, updated_at = now()
      from unnest(array[${list}]::uuid[]) with ordinality as o(id, pos)
     where m.property_id = ${propertyId} and m.id = o.id and m.position <> o.pos - 1`);
  return res.rowCount ?? 0;
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
): Promise<{ sha256: string | null; position: number; isCover: boolean } | null> {
  const [row] = await tx
    .delete(propertyMedia)
    .where(and(eq(propertyMedia.propertyId, propertyId), eq(propertyMedia.id, id)))
    .returning({ sha256: propertyMedia.sha256, position: propertyMedia.position, isCover: propertyMedia.isCover });
  return row ?? null;
}

// --- worker (withMedia) -------------------------------------------------------------------------------------

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

// --- processing and cleanup (S3-04, withMedia) ----------------------------------------------------------------

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

// --- listing documents (S3-F5): STRICT, the owner agency's own rows under RLS ------------------------------------

export type DocumentRow = Pick<
  typeof listingDocuments.$inferSelect,
  'id' | 'fileName' | 'sizeBytes' | 'createdAt' | 'storageKey' | 'sha256'
>;
const documentColumns = {
  id: listingDocuments.id,
  fileName: listingDocuments.fileName,
  sizeBytes: listingDocuments.sizeBytes,
  createdAt: listingDocuments.createdAt,
  storageKey: listingDocuments.storageKey,
  sha256: listingDocuments.sha256,
};

/** A listing's documents, oldest first (`listing_documents_property_idx`); at most `LISTING_DOCUMENTS_MAX`. */
export async function listDocuments(tx: Tx, agencyId: string, propertyId: string): Promise<DocumentRow[]> {
  return tx
    .select(documentColumns)
    .from(listingDocuments)
    .where(and(eq(listingDocuments.agencyId, agencyId), eq(listingDocuments.propertyId, propertyId)))
    .orderBy(asc(listingDocuments.createdAt), asc(listingDocuments.id));
}

/** Scoped to the agency as well as RLS (STRICT): defence in depth for a private file. */
export async function getDocument(
  tx: Tx,
  agencyId: string,
  propertyId: string,
  id: string,
): Promise<DocumentRow | null> {
  const [row] = await tx
    .select(documentColumns)
    .from(listingDocuments)
    .where(
      and(
        eq(listingDocuments.agencyId, agencyId),
        eq(listingDocuments.propertyId, propertyId),
        eq(listingDocuments.id, id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertDocument(tx: Tx, row: typeof listingDocuments.$inferInsert): Promise<DocumentRow> {
  const [inserted] = await tx.insert(listingDocuments).values(row).returning(documentColumns);
  return inserted as DocumentRow;
}

export async function deleteDocument(tx: Tx, agencyId: string, propertyId: string, id: string): Promise<string | null> {
  const [row] = await tx
    .delete(listingDocuments)
    .where(
      and(
        eq(listingDocuments.agencyId, agencyId),
        eq(listingDocuments.propertyId, propertyId),
        eq(listingDocuments.id, id),
      ),
    )
    .returning({ storageKey: listingDocuments.storageKey });
  return row?.storageKey ?? null;
}
