/**
 * mls deal disputes (R2-04c, PLAN §3 #10 "disputes → staff mediation"). A party asks staff to step in on a deal — the
 * price, the stage, the completion or the commission — with a reason; staff mediate the deal (`mediateDeal`) and close
 * the dispute with a note the raising agency reads.
 *
 * - **Who raises one.** The members who bind the agency on the deal (`assertMayBind`: the introducer's members; on the
 *   owner's side its admins or the listing's agent), on any stage — a closed deal is exactly where a party has no other
 *   move. Never in Client Mode or while impersonated (`mls.deals.write`). One open dispute per agency and deal.
 * - **What the other party learns.** That a dispute was raised (`mls.deal.changed` `DISPUTED`: the counterpart's
 *   notification), never its text: the rows are the raising agency's own (RLS).
 * - **Staff.** Every staff role reads the queue and a deal's disputes; data ops and super admins resolve one (audited
 *   `staff.mls.dealDisputeResolved` in the raising agency's log; `DISPUTE_RESOLVED` tells that agency).
 */
import {
  DEAL_DISPUTES_LISTED,
  type DealDisputeDto,
  type DealDisputeList,
  type DealDisputeStatus,
  type DealStage,
  type OpenDealDisputeBody,
  type ResolveDealDisputeBody,
  type StaffDealDisputeDto,
  type StaffDealDisputeList,
  type StaffDealDisputePage,
  StaffDealDisputesQuery,
  type ViewingSide,
} from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { type Ctx, memberUserId, type StaffCtx } from '../../context';
import { advisoryLock } from '../../idempotency';
import { decodeCursor, encodeCursor } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as repo from './deal-disputes-repo';
import { assertMayBind, introducerOf, ownerOf } from './deals';
import * as deals from './deals-repo';
import { mlsEvents } from './events';
import { assertCan, assertStaffCan } from './policy';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const dto = (d: repo.DisputeRow): DealDisputeDto => ({
  id: d.id,
  dealId: d.dealId,
  status: d.status as DealDisputeStatus,
  reason: d.reason,
  resolutionNote: d.resolutionNote,
  createdAt: d.createdAt.toISOString(),
  resolvedAt: iso(d.resolvedAt),
});

/**
 * `POST /v1/mls/deals/:id/disputes`: the caller's side raises a dispute of the deal for staff mediation. Takes the deal's
 * lock (as every move on it); ≤ 7 statements (deal, lock, deal, agent, insert, audit, outbox).
 */
export async function openDealDispute(ctx: Ctx, dealId: string, input: OpenDealDisputeBody): Promise<DealDisputeDto> {
  assertCan(ctx, 'mls.deals.write');
  const agencyId = ctx.tenant.agencyId;
  // the caller's own copy first (no lock on another agency's deal), then the deal's lock as every move on it takes
  if (!(await deals.dealOf(ctx.tx, agencyId, dealId))) throw new AppError('DEAL_NOT_FOUND');
  await advisoryLock(ctx.tx, `mls.deal:${dealId}`);
  const deal = await deals.dealOf(ctx.tx, agencyId, dealId);
  if (!deal) throw new AppError('DEAL_NOT_FOUND');
  await assertMayBind(ctx, deal);
  const row = await repo.insertDispute(ctx.tx, {
    id: newId(),
    agencyId,
    dealId,
    reason: input.reason,
    openedByUserId: memberUserId(ctx),
  });
  if (!row) throw new AppError('DEAL_DISPUTE_STATE', { reason: 'open' });
  await compliance.audit(
    ctx,
    'mls.deal.disputed',
    { type: 'dealDispute', id: row.id },
    {
      dealId,
      party: deal.party,
      stage: deal.stage,
    },
  );
  await emit(
    ctx.tx,
    mlsEvents.dealChanged({
      agencyId,
      dealId,
      introducerAgencyId: introducerOf(deal),
      ownerAgencyId: ownerOf(deal),
      action: 'DISPUTED',
      by: deal.party,
      userId: memberUserId(ctx),
    }),
  );
  return dto(row);
}

/** `GET /v1/mls/deals/:id/disputes`: the caller's agency's disputes of the deal, newest first. Two statements. */
export async function listDealDisputes(ctx: Ctx, dealId: string): Promise<DealDisputeList> {
  assertCan(ctx, 'mls.deals.read');
  const agencyId = ctx.tenant.agencyId;
  const deal = await deals.dealOf(ctx.tx, agencyId, dealId);
  if (!deal) throw new AppError('DEAL_NOT_FOUND');
  const rows = await repo.disputesOfDeal(ctx.tx, agencyId, dealId, DEAL_DISPUTES_LISTED);
  return { items: rows.map(dto) };
}

// ---- staff ------------------------------------------------------------------------------------------------------------

async function staffDtos(ctx: StaffCtx, rows: readonly repo.StaffDisputeRow[]): Promise<StaffDealDisputeDto[]> {
  if (rows.length === 0) return [];
  const names = await agencies.agencyNames(
    ctx,
    rows.map((r) => r.agencyId),
  );
  return rows.map((r) => ({
    ...dto(r),
    agency: { id: r.agencyId, name: names.get(r.agencyId) ?? '' },
    party: r.party as ViewingSide,
    dealStage: r.dealStage as DealStage,
  }));
}

/** `GET /v1/staff/deal-disputes`: every agency's disputes of one status, oldest first (the mediation queue). Two statements. */
export async function listStaffDealDisputes(ctx: StaffCtx, raw: StaffDealDisputesQuery): Promise<StaffDealDisputePage> {
  assertStaffCan(ctx, 'staff.mls.read');
  const q = StaffDealDisputesQuery.parse(raw);
  const rows = await repo.staffDisputesPage(ctx.tx, {
    status: q.status,
    cursor: decodeCursor(q.cursor),
    limit: q.limit,
  });
  const items = rows.slice(0, q.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > q.limit && last ? encodeCursor({ at: last.createdAt, id: last.id, atUs: last.atUs }) : null;
  return { items: await staffDtos(ctx, items), nextCursor };
}

/** `GET /v1/staff/deals/:id/disputes`: both parties' disputes of a deal, newest first. Two statements. */
export async function listStaffDisputesOfDeal(ctx: StaffCtx, dealId: string): Promise<StaffDealDisputeList> {
  assertStaffCan(ctx, 'staff.mls.read');
  const rows = await repo.staffDisputesOfDeal(ctx.tx, dealId, DEAL_DISPUTES_LISTED);
  return { items: await staffDtos(ctx, rows) };
}

/**
 * `POST /v1/staff/deal-disputes/:id/resolve` (data ops, super admins): close an open dispute with a note the raising
 * agency reads. Audited in that agency's log (`staff.mls.dealDisputeResolved`: the deal, never the note); the agency is
 * told (`mls.deal.changed` `DISPUTE_RESOLVED`, by staff). Changing the deal is a mediation of its own.
 */
export async function resolveDealDispute(
  ctx: StaffCtx,
  id: string,
  input: ResolveDealDisputeBody,
): Promise<StaffDealDisputeDto> {
  assertStaffCan(ctx, 'staff.mls.mediate');
  const d = await repo.staffDisputeForUpdate(ctx.tx, id);
  if (!d) throw new AppError('DEAL_DISPUTE_NOT_FOUND');
  if (d.status !== 'OPEN') throw new AppError('DEAL_DISPUTE_STATE', { reason: 'resolved' });
  const deal = await deals.dealOf(ctx.tx, d.agencyId, d.dealId);
  if (!deal) throw new AppError('DEAL_NOT_FOUND');
  const resolved = await repo.resolveDispute(ctx.tx, d.id, { userId: ctx.actor.userId, note: input.note });
  if (!resolved) throw new AppError('DEAL_DISPUTE_STATE', { reason: 'resolved' });
  await compliance.auditStaff(
    ctx,
    d.agencyId,
    'staff.mls.dealDisputeResolved',
    { type: 'dealDispute', id: d.id },
    { dealId: d.dealId, stage: deal.stage },
  );
  await emit(
    ctx.tx,
    mlsEvents.dealChanged({
      agencyId: d.agencyId,
      dealId: d.dealId,
      introducerAgencyId: introducerOf(deal),
      ownerAgencyId: ownerOf(deal),
      action: 'DISPUTE_RESOLVED',
      by: 'STAFF',
      userId: ctx.actor.userId,
    }),
  );
  const [out] = await staffDtos(ctx, [{ ...resolved, party: deal.party, dealStage: deal.stage }]);
  return out as StaffDealDisputeDto;
}
