/**
 * media queries (PATTERNS §5). Takes `tx`, selects only the columns it needs. Queries only
 * `@inmolink/db/schema/media` — other modules' tables fail `pnpm check:boundaries`. Request work runs as
 * `app_user` (RLS: own listing media, plus shared listings' non-document media; `media_objects` read-only);
 * the worker's reference counting runs through `withSystem()`.
 */
import type { Tx } from '@inmolink/db';
import { mediaObjects, propertyMedia } from '@inmolink/db/schema/media';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';

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

/** Stored objects among `hashes` (one PK probe each), with their pending deletion if unreferenced. */
export async function storedObjects(tx: Tx, hashes: string[]): Promise<Map<string, { deleteAfter: Date | null }>> {
  if (hashes.length === 0) return new Map();
  const rows = await tx
    .select({ sha256: mediaObjects.sha256, deleteAfter: mediaObjects.deleteAfter })
    .from(mediaObjects)
    .where(inArray(mediaObjects.sha256, hashes));
  return new Map(rows.map((r) => [r.sha256, { deleteAfter: r.deleteAfter }]));
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
