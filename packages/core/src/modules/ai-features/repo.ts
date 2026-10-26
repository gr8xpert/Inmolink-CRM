/**
 * ai-features queries (PATTERNS §5). Takes `tx`, selects only the columns it needs.
 * Queries only `@inmolink/db/schema/ai-features` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import { listingStudioBatches, listingStudioUsage, whiteLabelBatches } from '@inmolink/db/schema/ai-features';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';

export type StudioBatchRow = typeof listingStudioBatches.$inferSelect;
export type StudioBatchInsert = typeof listingStudioBatches.$inferInsert;

/** Inserts the batch record; an existing one (a retried submit job) is kept. True when inserted. */
export async function insertStudioBatch(tx: Tx, row: StudioBatchInsert): Promise<boolean> {
  const rows = await tx
    .insert(listingStudioBatches)
    .values(row)
    .onConflictDoNothing({ target: listingStudioBatches.id })
    .returning({ id: listingStudioBatches.id });
  return rows.length > 0;
}

/**
 * Serializes the agency's bulk studio requests (S12-02 review): a transaction-scoped advisory lock, released at
 * commit, so the running-batch count and the reservation of concurrent requests happen one after the other.
 */
export async function lockAgencyStudio(tx: Tx, agencyId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`aiFeatures.studio:${agencyId}`}))`);
}

/** S13-F21: listings the agency asked Studio for in `month` (first day, `YYYY-MM-01`). Primary key probe. */
export async function studioListingsIn(tx: Tx, agencyId: string, month: string): Promise<number> {
  const [row] = await tx
    .select({ n: listingStudioUsage.listings })
    .from(listingStudioUsage)
    .where(and(eq(listingStudioUsage.agencyId, agencyId), eq(listingStudioUsage.month, month)))
    .limit(1);
  return row?.n ?? 0;
}

/** S13-F21: counts `n` more listings asked of Studio in `month` (one upsert). */
export async function addStudioListings(tx: Tx, agencyId: string, month: string, n: number): Promise<void> {
  await tx
    .insert(listingStudioUsage)
    .values({ agencyId, month, listings: n })
    .onConflictDoUpdate({
      target: [listingStudioUsage.agencyId, listingStudioUsage.month],
      set: { listings: sql`${listingStudioUsage.listings} + ${n}`, updatedAt: sql`now()` },
    });
}

/** Records the items of a reserved batch (only while it has none: a retried submit never replaces them). */
export async function fillStudioBatch(
  tx: Tx,
  agencyId: string,
  id: string,
  items: unknown[],
  factsHashes: string[],
): Promise<boolean> {
  const rows = await tx
    .update(listingStudioBatches)
    .set({ items, factsHashes, updatedAt: sql`now()` })
    .where(
      and(
        eq(listingStudioBatches.id, id),
        eq(listingStudioBatches.agencyId, agencyId),
        sql`${listingStudioBatches.items} = '[]'::jsonb`,
      ),
    )
    .returning({ id: listingStudioBatches.id });
  return rows.length > 0;
}

/** One batch of the agency (primary key). */
export async function getStudioBatch(tx: Tx, agencyId: string, id: string): Promise<StudioBatchRow | null> {
  const [row] = await tx
    .select()
    .from(listingStudioBatches)
    .where(and(eq(listingStudioBatches.id, id), eq(listingStudioBatches.agencyId, agencyId)));
  return row ?? null;
}

export async function setStudioBatchProvider(tx: Tx, agencyId: string, id: string, providerBatchId: string) {
  await tx
    .update(listingStudioBatches)
    .set({ providerBatchId, updatedAt: sql`now()` })
    .where(and(eq(listingStudioBatches.id, id), eq(listingStudioBatches.agencyId, agencyId)));
}

/** Marks a running batch finished; false when it already was (a re-run applies nothing twice). */
export async function finishStudioBatch(
  tx: Tx,
  agencyId: string,
  id: string,
  result: { state: 'DONE' | 'GAVE_UP'; written: number; dropped: number },
): Promise<boolean> {
  const rows = await tx
    .update(listingStudioBatches)
    .set({ ...result, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(listingStudioBatches.id, id),
        eq(listingStudioBatches.agencyId, agencyId),
        eq(listingStudioBatches.state, 'RUNNING'),
      ),
    )
    .returning({ id: listingStudioBatches.id });
  return rows.length > 0;
}

/** The agency's running bulk batches of the last 2 days (S12-02 review cap): `listing_studio_batches_agency_created_idx`. */
export async function countRunningStudioBatches(tx: Tx, agencyId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(listingStudioBatches)
    .where(
      and(
        eq(listingStudioBatches.agencyId, agencyId),
        eq(listingStudioBatches.state, 'RUNNING'),
        // a batch ends within a day: an older RUNNING row is a lost job, not a running batch
        sql`${listingStudioBatches.createdAt} > now() - interval '2 days'`,
      ),
    );
  return row?.n ?? 0;
}

/** Deletes up to `limit` batches created before `before` (all agencies, `withSystem`), oldest first. */
export async function pruneStudioBatches(tx: Tx, before: Date, limit: number): Promise<number> {
  const due = tx
    .select({ id: listingStudioBatches.id })
    .from(listingStudioBatches)
    .where(lt(listingStudioBatches.createdAt, before))
    .orderBy(asc(listingStudioBatches.createdAt))
    .limit(limit);
  const rows = await tx
    .delete(listingStudioBatches)
    .where(inArray(listingStudioBatches.id, due))
    .returning({ id: listingStudioBatches.id });
  return rows.length;
}

// ---- S13-F25: white-label backfill batches (worker-only, `withSystem`) -------------------------------------------

export type WhiteLabelBatchRow = Pick<
  typeof whiteLabelBatches.$inferSelect,
  'id' | 'agencyId' | 'pageKey' | 'items' | 'cursor' | 'providerBatchId' | 'state'
>;

const whiteLabelBatchColumns = {
  id: whiteLabelBatches.id,
  agencyId: whiteLabelBatches.agencyId,
  pageKey: whiteLabelBatches.pageKey,
  items: whiteLabelBatches.items,
  cursor: whiteLabelBatches.cursor,
  providerBatchId: whiteLabelBatches.providerBatchId,
  state: whiteLabelBatches.state,
};

/**
 * Records a backfill page's items under its page key; a retried submit finds the page's first record and gets it back
 * (its items are what is sent, never a second set). `white_label_batches_page_uq`.
 */
export async function insertWhiteLabelBatch(
  tx: Tx,
  row: { id: string; agencyId: string; pageKey: string; items: unknown[]; cursor: unknown },
): Promise<WhiteLabelBatchRow> {
  const [inserted] = await tx
    .insert(whiteLabelBatches)
    .values(row)
    .onConflictDoNothing({ target: [whiteLabelBatches.agencyId, whiteLabelBatches.pageKey] })
    .returning(whiteLabelBatchColumns);
  if (inserted) return inserted;
  return (await getWhiteLabelBatch(tx, row.agencyId, row.pageKey)) as WhiteLabelBatchRow;
}

/** The agency's batch of one backfill page (`white_label_batches_page_uq`). */
export async function getWhiteLabelBatch(
  tx: Tx,
  agencyId: string,
  pageKey: string,
): Promise<WhiteLabelBatchRow | null> {
  const [row] = await tx
    .select(whiteLabelBatchColumns)
    .from(whiteLabelBatches)
    .where(and(eq(whiteLabelBatches.agencyId, agencyId), eq(whiteLabelBatches.pageKey, pageKey)))
    .limit(1);
  return row ?? null;
}

/** Saves the submit's outcome: the items with the answers the cache had, and the provider's batch id (if any). */
export async function setWhiteLabelBatchSubmitted(
  tx: Tx,
  agencyId: string,
  id: string,
  patch: { items: unknown[]; providerBatchId: string | null },
): Promise<void> {
  await tx
    .update(whiteLabelBatches)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(
      and(
        eq(whiteLabelBatches.id, id),
        eq(whiteLabelBatches.agencyId, agencyId),
        eq(whiteLabelBatches.state, 'RUNNING'),
      ),
    );
}

/** Marks a running batch finished; false when it already was (a re-run applies nothing twice). */
export async function finishWhiteLabelBatch(
  tx: Tx,
  agencyId: string,
  id: string,
  state: 'DONE' | 'GAVE_UP',
): Promise<boolean> {
  const rows = await tx
    .update(whiteLabelBatches)
    .set({ state, updatedAt: sql`now()` })
    .where(
      and(
        eq(whiteLabelBatches.id, id),
        eq(whiteLabelBatches.agencyId, agencyId),
        eq(whiteLabelBatches.state, 'RUNNING'),
      ),
    )
    .returning({ id: whiteLabelBatches.id });
  return rows.length > 0;
}

/** Deletes up to `limit` backfill batches created before `before` (all agencies, `withSystem`), oldest first. */
export async function pruneWhiteLabelBatches(tx: Tx, before: Date, limit: number): Promise<number> {
  const due = tx
    .select({ id: whiteLabelBatches.id })
    .from(whiteLabelBatches)
    .where(lt(whiteLabelBatches.createdAt, before))
    .orderBy(asc(whiteLabelBatches.createdAt))
    .limit(limit);
  const rows = await tx
    .delete(whiteLabelBatches)
    .where(inArray(whiteLabelBatches.id, due))
    .returning({ id: whiteLabelBatches.id });
  return rows.length;
}
