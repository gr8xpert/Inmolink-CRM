/**
 * mls deal-room queries (R2-04a, PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor. A
 * party reads and writes its own copy (`agency_id` = the caller's agency); the definer triggers append and keep the
 * peer's copy in step. Staff read and mediate on the owner's copy (the sync copies the mediation to the introducer's).
 */
import type { DealStage } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { deals } from '@inmolink/db/schema/mls';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, rowAfter } from '../../pagination';

export type Party = 'OWNER' | 'INTRODUCER';

const columns = {
  agencyId: deals.agencyId,
  id: deals.id,
  party: deals.party,
  peerAgencyId: deals.peerAgencyId,
  viewingRequestId: deals.viewingRequestId,
  targetKind: deals.targetKind,
  targetId: deals.targetId,
  commissionBp: deals.commissionBp,
  commissionFixedCents: deals.commissionFixedCents,
  commissionCurrency: deals.commissionCurrency,
  splitBp: deals.splitBp,
  commissionIncludesVat: deals.commissionIncludesVat,
  termsAt: deals.termsAt,
  stage: deals.stage,
  stageAt: deals.stageAt,
  priceCents: deals.priceCents,
  currency: deals.currency,
  commissionTotalCents: deals.commissionTotalCents,
  introducerShareCents: deals.introducerShareCents,
  ownerShareCents: deals.ownerShareCents,
  ownerConfirmedAt: deals.ownerConfirmedAt,
  ownerConfirmedBy: deals.ownerConfirmedBy,
  introducerConfirmedAt: deals.introducerConfirmedAt,
  introducerConfirmedBy: deals.introducerConfirmedBy,
  completedAt: deals.completedAt,
  fellThroughAt: deals.fellThroughAt,
  fellThroughReason: deals.fellThroughReason,
  closedBy: deals.closedBy,
  mediatedAt: deals.mediatedAt,
  mediationReason: deals.mediationReason,
  createdAt: deals.createdAt,
  updatedAt: deals.updatedAt,
  createdMs: deals.createdMs,
};

type Selected = Omit<typeof deals.$inferSelect, 'mediatedBy' | 'openedByUserId'>;

export interface DealRow extends Omit<Selected, 'party'> {
  party: Party;
}

const asRow = (r: Selected): DealRow => ({ ...r, party: r.party as Party });

/** The caller's copy of a deal (the primary key). */
export async function dealOf(tx: Tx, agencyId: string, id: string): Promise<DealRow | null> {
  const [row] = await tx
    .select(columns)
    .from(deals)
    .where(and(eq(deals.agencyId, agencyId), eq(deals.id, id)));
  return row ? asRow(row) : null;
}

/** The agency's live (not fallen-through) deal of a viewing request (`deals_viewing_open_uq`). */
export async function liveDealOf(tx: Tx, agencyId: string, viewingRequestId: string): Promise<DealRow | null> {
  const [row] = await tx
    .select(columns)
    .from(deals)
    .where(
      and(
        eq(deals.agencyId, agencyId),
        eq(deals.viewingRequestId, viewingRequestId),
        sql`${deals.stage} <> 'FELL_THROUGH'`,
      ),
    );
  return row ? asRow(row) : null;
}

/** The agency's deals, newest first (`deals_agency_created_idx`), limit + 1 rows. */
export async function dealPage(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor | undefined; stage?: DealStage | undefined },
): Promise<DealRow[]> {
  const rows = await tx
    .select(columns)
    .from(deals)
    .where(
      and(
        eq(deals.agencyId, agencyId),
        rowAfter(deals.createdMs, deals.id, page.cursor),
        page.stage ? eq(deals.stage, page.stage) : undefined,
      ),
    )
    .orderBy(desc(deals.createdMs), desc(deals.id))
    .limit(page.limit + 1);
  return rows.map(asRow);
}

export interface NewDeal {
  id: string;
  agencyId: string;
  party: Party;
  peerAgencyId: string;
  viewingRequestId: string;
  /** The terms as the caller's viewing row holds them; `deals_insert_guard` copies them again from that row. */
  targetKind: string;
  targetId: string;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  commissionCurrency: string | null;
  splitBp: number;
  commissionIncludesVat: boolean;
  termsAt: Date;
  priceCents: number;
  currency: string;
}

/** Opens the caller's copy at `OFFER` (the mirror appends the peer's in the same statement). */
export async function insertDeal(tx: Tx, d: NewDeal): Promise<DealRow> {
  const [row] = await tx
    .insert(deals)
    .values({ ...d, stage: 'OFFER' })
    .returning(columns);
  if (!row) throw new Error('mls: deal insert returned no row');
  return asRow(row);
}

/** What a party's move changes on its own copy (the guard stamps the times). */
export interface DealPatch {
  stage?: string;
  priceCents?: number;
  currency?: string;
  ownerConfirmedBy?: string | null;
  introducerConfirmedBy?: string | null;
  fellThroughReason?: string;
  closedBy?: string;
}

const confirmedAt = (by: string | null | undefined): SQL | null | undefined =>
  by === undefined ? undefined : by === null ? null : sql`now()`;

/**
 * Updates the caller's copy if its stage is still the one read (under the deal's lock; one statement); the guard checks the move and stamps
 * its times, the sync copies it to the peer's. Null when the deal moved meanwhile.
 */
export async function updateDeal(tx: Tx, row: DealRow, patch: DealPatch): Promise<DealRow | null> {
  const set: Record<string, unknown> = { ...patch, updatedAt: sql`now()` };
  const owner = confirmedAt(patch.ownerConfirmedBy);
  const introducer = confirmedAt(patch.introducerConfirmedBy);
  if (owner !== undefined) set.ownerConfirmedAt = owner;
  if (introducer !== undefined) set.introducerConfirmedAt = introducer;
  if (patch.stage === 'COMPLETION') set.completedAt = sql`now()`;
  if (patch.stage === 'FELL_THROUGH') set.fellThroughAt = sql`now()`;
  if (patch.stage !== undefined && patch.stage !== row.stage) set.stageAt = sql`now()`;
  const [out] = await tx
    .update(deals)
    .set(set)
    .where(and(eq(deals.agencyId, row.agencyId), eq(deals.id, row.id), eq(deals.stage, row.stage)))
    .returning(columns);
  return out ? asRow(out) : null;
}

// ---- staff ------------------------------------------------------------------------------------------------------------

/** Staff: the owner's copy of a deal (`deals_id_idx`). */
export async function staffDealOf(tx: Tx, id: string): Promise<DealRow | null> {
  const [row] = await tx
    .select(columns)
    .from(deals)
    .where(and(eq(deals.id, id), eq(deals.party, 'OWNER')));
  return row ? asRow(row) : null;
}

export interface MediationPatch {
  stage: string;
  priceCents: number;
  currency: string;
  ownerConfirmedAt: Date | null;
  ownerConfirmedBy: string | null;
  introducerConfirmedAt: Date | null;
  introducerConfirmedBy: string | null;
  completedAt: Date | SQL | null;
  fellThroughAt: Date | SQL | null;
  fellThroughReason: string | null;
  closedBy: string | null;
  stageAt: Date | SQL;
  mediatedBy: string;
  mediationReason: string;
}

/** Staff mediation on the owner's copy, if its stage is still the one read (the guard stamps `mediated_at`; the sync copies it). */
export async function mediateDeal(tx: Tx, row: DealRow, patch: MediationPatch): Promise<DealRow | null> {
  const [out] = await tx
    .update(deals)
    .set({ ...patch, mediatedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(deals.agencyId, row.agencyId), eq(deals.id, row.id), eq(deals.stage, row.stage)))
    .returning(columns);
  return out ? asRow(out) : null;
}

// ---- worker (app_system) ----------------------------------------------------------------------------------------------

export interface DealCopy {
  agencyId: string;
  party: Party;
  peerAgencyId: string;
  viewingRequestId: string;
  targetKind: string;
  targetId: string;
  stage: string;
}

/** R2-04b, worker side: both parties' copies of a deal (`deals_id_party_uq`: `where id = ?`; at most two rows). */
export async function copiesOf(tx: Tx, id: string): Promise<DealCopy[]> {
  const rows = await tx
    .select({
      agencyId: deals.agencyId,
      party: deals.party,
      peerAgencyId: deals.peerAgencyId,
      viewingRequestId: deals.viewingRequestId,
      targetKind: deals.targetKind,
      targetId: deals.targetId,
      stage: deals.stage,
    })
    .from(deals)
    .where(eq(deals.id, id))
    .limit(2);
  return rows.map((r) => ({ ...r, party: r.party as Party }));
}
