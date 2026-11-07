/**
 * mls deal disputes (R2-04c, PATTERNS §5). A party reads and writes its own rows (`agency_id` = the caller's agency,
 * RLS); staff read every agency's and resolve them. Takes `tx`, selects only the columns it needs, keyset pages.
 */
import type { Tx } from '@inmolink/db';
import { deals, dealDisputes as disputes } from '@inmolink/db/schema/mls';
import { and, desc, eq, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

const columns = {
  id: disputes.id,
  agencyId: disputes.agencyId,
  dealId: disputes.dealId,
  status: disputes.status,
  reason: disputes.reason,
  resolutionNote: disputes.resolutionNote,
  createdAt: disputes.createdAt,
  resolvedAt: disputes.resolvedAt,
  atUs: keysetStamp(disputes.createdAt),
};

export interface DisputeRow {
  id: string;
  agencyId: string;
  dealId: string;
  status: string;
  reason: string;
  resolutionNote: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  atUs: string;
}

/** A staff row: the dispute with the raising agency's side of the deal and the deal's stage now. */
export interface StaffDisputeRow extends DisputeRow {
  party: string;
  dealStage: string;
}

/** A member opens a dispute (`OPEN`) on its own copy of the deal; null when one is open already. One statement. */
export async function insertDispute(
  tx: Tx,
  row: { id: string; agencyId: string; dealId: string; reason: string; openedByUserId: string },
): Promise<DisputeRow | null> {
  const [inserted] = await tx
    .insert(disputes)
    .values({ ...row, status: 'OPEN' })
    .onConflictDoNothing({
      target: [disputes.agencyId, disputes.dealId],
      where: sql`${disputes.status} = 'OPEN'`,
    })
    .returning(columns);
  return inserted ?? null;
}

/** The agency's disputes of one deal, newest first (`deal_disputes_deal_idx`), at most `limit`. One statement. */
export function disputesOfDeal(tx: Tx, agencyId: string, dealId: string, limit: number): Promise<DisputeRow[]> {
  return tx
    .select(columns)
    .from(disputes)
    .where(and(eq(disputes.agencyId, agencyId), eq(disputes.dealId, dealId)))
    .orderBy(desc(disputes.createdAt), desc(disputes.id))
    .limit(limit);
}

// ---- staff ------------------------------------------------------------------------------------------------------------

const staffColumns = { ...columns, party: deals.party, dealStage: deals.stage };

const withDeal = (tx: Tx) =>
  tx
    .select(staffColumns)
    .from(disputes)
    .innerJoin(deals, and(eq(deals.agencyId, disputes.agencyId), eq(deals.id, disputes.dealId)));

/** Every agency's disputes of one status, oldest first (`deal_disputes_status_idx`; keyset, `limit + 1`). One statement. */
export function staffDisputesPage(
  tx: Tx,
  q: { status: string; cursor?: KeysetCursor | undefined; limit: number },
): Promise<StaffDisputeRow[]> {
  return withDeal(tx)
    .where(and(eq(disputes.status, q.status), keysetAfterRaw(disputes.createdAt, disputes.id, q.cursor, 'asc')))
    .orderBy(...keysetOrderRaw(disputes.createdAt, disputes.id, 'asc'))
    .limit(q.limit + 1);
}

/** Both parties' disputes of a deal, newest first (`deal_disputes_deal_id_idx`), at most `limit`. One statement. */
export function staffDisputesOfDeal(tx: Tx, dealId: string, limit: number): Promise<StaffDisputeRow[]> {
  return withDeal(tx)
    .where(eq(disputes.dealId, dealId))
    .orderBy(desc(disputes.createdAt), desc(disputes.id))
    .limit(limit);
}

/** One dispute, any agency's, locked until the transaction ends (staff). One statement. */
export async function staffDisputeForUpdate(tx: Tx, id: string): Promise<DisputeRow | null> {
  const [row] = await tx.select(columns).from(disputes).where(eq(disputes.id, id)).for('update');
  return row ?? null;
}

/** Staff resolve an open dispute (status, who, when, the note). One statement. */
export async function resolveDispute(
  tx: Tx,
  id: string,
  r: { userId: string; note: string },
): Promise<DisputeRow | null> {
  const [row] = await tx
    .update(disputes)
    .set({
      status: 'RESOLVED',
      resolvedByUserId: r.userId,
      resolutionNote: r.note,
      resolvedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(disputes.id, id), eq(disputes.status, 'OPEN')))
    .returning(columns);
  return row ?? null;
}
