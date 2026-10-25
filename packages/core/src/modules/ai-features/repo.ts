/**
 * ai-features queries (PATTERNS §5). Takes `tx`, selects only the columns it needs.
 * Queries only `@inmolink/db/schema/ai-features` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import { listingStudioBatches } from '@inmolink/db/schema/ai-features';
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
