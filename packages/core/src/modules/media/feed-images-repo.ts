/**
 * Feed image queries (S6-02): the per-listing queue the import fills and the media worker drains, the URL → hash
 * memory (hash-first), and the listing media summary the worker appends to. Queries only `@inmolink/db/schema/media`.
 * Runs as `app_user` for the agency (`withTenant`, RLS), except the overdue sweep (`withSystem`).
 */
import type { Tx } from '@inmolink/db';
import { feedImageQueue, feedImageSources, propertyMedia } from '@inmolink/db/schema/media';
import { and, eq, inArray, sql } from 'drizzle-orm';

const leaseUntil = (leaseMs: number) => sql`now() + ${`${leaseMs} milliseconds`}::interval`;

/** Queues (or replaces) each listing's image URLs; a newer list for a claimed row is kept for the next claim. */
export async function upsertQueue(
  tx: Tx,
  agencyId: string,
  rows: readonly { listingId: string; urls: readonly string[] }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(feedImageQueue)
    .values(rows.map((r) => ({ propertyId: r.listingId, agencyId, urls: [...r.urls] })))
    .onConflictDoUpdate({
      target: feedImageQueue.propertyId,
      set: { urls: sql`excluded.urls`, createdAt: sql`now()`, updatedAt: sql`now()` },
    });
}

export interface ClaimedImages {
  propertyId: string;
  urls: string[];
}

/** Claims up to `limit` of the agency's waiting listings, oldest first (`FOR UPDATE SKIP LOCKED`, a lease). */
export async function claim(tx: Tx, agencyId: string, limit: number, leaseMs: number): Promise<ClaimedImages[]> {
  const res = await tx.execute(sql`
    update feed_image_queue q
       set claimed_until = ${leaseUntil(leaseMs)}, updated_at = now()
     where q.property_id in (
       select property_id from feed_image_queue
        where agency_id = ${agencyId} and (claimed_until is null or claimed_until < now())
        order by created_at
        limit ${limit}
          for update skip locked)
    returning q.property_id as "propertyId", q.urls`);
  return res.rows as unknown as ClaimedImages[];
}

/** Done: drops the rows whose URLs are still the claimed ones; a row re-queued meanwhile is released instead. */
export async function complete(tx: Tx, done: readonly ClaimedImages[]): Promise<void> {
  if (done.length === 0) return;
  await tx.execute(sql`
    delete from feed_image_queue q
     using jsonb_to_recordset(${JSON.stringify(done)}::jsonb) as d("propertyId" uuid, urls text[])
     where q.property_id = d."propertyId" and q.urls = d.urls`);
  await tx
    .update(feedImageQueue)
    .set({ claimedUntil: null, updatedAt: sql`now()` })
    .where(
      inArray(
        feedImageQueue.propertyId,
        done.map((d) => d.propertyId),
      ),
    );
}

/** Gives claimed rows back untouched (a cancelled run): the next run takes them again. */
export async function release(tx: Tx, claimed: readonly ClaimedImages[]): Promise<void> {
  if (claimed.length === 0) return;
  await tx
    .update(feedImageQueue)
    .set({ claimedUntil: null, updatedAt: sql`now()` })
    .where(
      inArray(
        feedImageQueue.propertyId,
        claimed.map((c) => c.propertyId),
      ),
    );
}

/** The content hash each known URL key served (hash-first). */
export async function sourcesFor(tx: Tx, agencyId: string, urlKeys: readonly string[]): Promise<Map<string, string>> {
  if (urlKeys.length === 0) return new Map();
  const rows = await tx
    .select({ urlKey: feedImageSources.urlKey, sha256: feedImageSources.sha256 })
    .from(feedImageSources)
    .where(and(eq(feedImageSources.agencyId, agencyId), inArray(feedImageSources.urlKey, [...new Set(urlKeys)])));
  return new Map(rows.map((r) => [r.urlKey, r.sha256]));
}

export async function upsertSources(
  tx: Tx,
  agencyId: string,
  rows: readonly { urlKey: string; sha256: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  const unique = [...new Map(rows.map((r) => [r.urlKey, r])).values()];
  await tx
    .insert(feedImageSources)
    .values(unique.map((r) => ({ agencyId, urlKey: r.urlKey, sha256: r.sha256 })))
    .onConflictDoUpdate({
      target: [feedImageSources.agencyId, feedImageSources.urlKey],
      set: { sha256: sql`excluded.sha256`, updatedAt: sql`now()` },
    });
}

export interface MediaSummary {
  hashes: Set<string>;
  count: number;
  nextPosition: number;
  hasCover: boolean;
}

/** Each listing's media: its hashes, how many, the next free position, whether it has a cover. One statement. */
export async function summaries(tx: Tx, propertyIds: readonly string[]): Promise<Map<string, MediaSummary>> {
  const out = new Map<string, MediaSummary>(
    propertyIds.map((id) => [id, { hashes: new Set(), count: 0, nextPosition: 0, hasCover: false }]),
  );
  if (propertyIds.length === 0) return out;
  const rows = await tx
    .select({
      propertyId: propertyMedia.propertyId,
      sha256: propertyMedia.sha256,
      position: propertyMedia.position,
      isCover: propertyMedia.isCover,
    })
    .from(propertyMedia)
    .where(inArray(propertyMedia.propertyId, [...propertyIds]));
  for (const r of rows) {
    const s = out.get(r.propertyId);
    if (!s) continue;
    if (r.sha256) s.hashes.add(r.sha256);
    s.count += 1;
    s.nextPosition = Math.max(s.nextPosition, r.position + 1);
    s.hasCover ||= r.isCover;
  }
  return out;
}

/**
 * Agencies with waiting rows nobody claimed for `olderThanMs` (a lost job): the sweep asks for their run again.
 *
 * S7-F3: a skip scan over `feed_image_queue_agency_created_idx` (one index probe per agency with waiting rows, not a
 * `distinct` over every waiting row), then per agency its next row to claim — the oldest unclaimed one, as `claim`
 * takes them — is overdue when untouched that long. A claim touches only the rows it claims, so rows still waiting
 * behind a long-running job keep their queue time and can flag the agency too: harmless, as `requestFeedImages` is
 * throttled per agency (enqueues within `THROTTLE_MS` are deduplicated) and the job runs one per agency, so the extra
 * run finds the rows claimed or takes them next. A lost job's rows (lease lapsed) are flagged the same way. The CTE is
 * `queued_agencies`, not `agencies` (S8-F4): it would shadow the real table.
 */
export async function overdueAgencies(tx: Tx, olderThanMs: number, limit: number): Promise<string[]> {
  const res = await tx.execute(sql`
    with recursive queued_agencies as (
      (select agency_id from feed_image_queue order by agency_id limit 1)
      union all
      select (select q.agency_id from feed_image_queue q where q.agency_id > a.agency_id order by q.agency_id limit 1)
        from queued_agencies a where a.agency_id is not null
    )
    select a.agency_id as "agencyId"
      from queued_agencies a
      cross join lateral (
        select q.updated_at from feed_image_queue q
         where q.agency_id = a.agency_id and (q.claimed_until is null or q.claimed_until < now())
         order by q.created_at limit 1) next
     where a.agency_id is not null and next.updated_at < now() - ${`${olderThanMs} milliseconds`}::interval
     limit ${limit}`);
  return (res.rows as { agencyId: string }[]).map((r) => r.agencyId);
}
