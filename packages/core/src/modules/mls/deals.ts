/**
 * mls deal room (R2-04a, PLAN §3 #10, §7 M10): a sale between the two agencies of an accepted viewing request.
 * `OFFER` → `RESERVATION` → `ARRAS` → `COMPLETION` (the handshake), or `FELL_THROUGH`. `(ctx: Ctx, input) → DTO`;
 * authorize with `assertCan`, read and write through `./deals-repo`, audit and emit in the same transaction.
 *
 * - **The two copies.** Each party holds its own copy (`deals`, `agency_id` = the holder); `deals_mirror` appends the
 *   peer's when the deal is opened and `deals_sync` keeps the shared state in step in the same statement. Each party's
 *   moves take the deal's advisory lock, then read its own copy; opening takes the viewing request's lock (both sides'
 *   viewing transitions take it too), so the two parties never open two deals of one viewing.
 * - **The terms and the commission.** The terms snapshot comes from the viewing request (the owner accepted it); the
 *   database copies it into the deal (`deals_insert_guard`) and computes the commission of the current price in
 *   generated columns — total = price × bp (or the fixed amount), the introducer's share = total × split, half-up to the
 *   cent (`./commission` is the reference the tests hold both to). Nothing here computes an amount the API answers.
 * - **Who.** Any member who works clients reads the agency's deals; binding the agency (open, advance, price, confirm,
 *   withdraw, fall-through) is, on the owner's side, its admins' or the listing's agent's (as accepting a viewing's terms, S11-02) — a development has no agent of its own.
 * - **The handshake.** Each side confirms the completion at the price it saw; a price change clears both confirmations
 *   (the guard); the second confirmation completes the deal. A completed or fallen-through deal changes only by staff
 *   mediation (`mediateDeal`, data ops and super admins, with a reason both parties see; audited for both agencies).
 */
import type {
  AdvanceDealBody,
  ConfirmDealBody,
  CreateDealBody,
  DealAction,
  DealDto,
  DealPage,
  DealPrice,
  FallThroughDealBody,
  ListDealsQuery,
  MediateDealBody,
  RegistrationTargetKind,
  SetDealPriceBody,
  StaffDealDto,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { type EventPayload, emit } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { type Ctx, memberUserId, type StaffCtx } from '../../context';
import { advisoryLock, isUniqueViolation } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as properties from '../properties';
import * as repo from './deals-repo';
import { mlsEvents } from './events';
import { type TargetLabels, targetLabels } from './labels';
import { assertCan, assertStaffCan, can } from './policy';
import * as viewings from './viewings-repo';

type Action = EventPayload<typeof mlsEvents.dealChanged>['action'];

const RANK: Readonly<Record<string, number>> = { OFFER: 1, RESERVATION: 2, ARRAS: 3, COMPLETION: 4 };
const CLOSED = new Set(['COMPLETION', 'FELL_THROUGH']);
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const isAdmin = (ctx: Ctx) => ctx.actor.kind === 'user' && ADMIN_ROLES.has(ctx.actor.role);
const ownerOf = (r: repo.DealRow) => (r.party === 'OWNER' ? r.agencyId : r.peerAgencyId);
const introducerOf = (r: repo.DealRow) => (r.party === 'INTRODUCER' ? r.agencyId : r.peerAgencyId);
const ownConfirmation = (r: repo.DealRow) => (r.party === 'OWNER' ? r.ownerConfirmedAt : r.introducerConfirmedAt);
const peerConfirmation = (r: repo.DealRow) => (r.party === 'OWNER' ? r.introducerConfirmedAt : r.ownerConfirmedAt);

const refuse = (reason: string): never => {
  throw new AppError('DEAL_STATE', { reason });
};

/** A fixed commission is in its own currency: the deal's price must be too (`deals_terms_ck`). */
function assertCurrency(
  terms: { commissionFixedCents: number | null; commissionCurrency: string | null },
  price: DealPrice,
) {
  if (terms.commissionFixedCents !== null && terms.commissionCurrency !== price.currency) {
    throw new AppError('VALIDATION_FAILED', { field: 'price.currency', reason: 'commission_currency' });
  }
}

// ---- DTOs -------------------------------------------------------------------------------------------------------------

function coreOf(r: repo.DealRow) {
  return {
    id: r.id,
    viewingRequestId: r.viewingRequestId,
    target: { kind: r.targetKind as RegistrationTargetKind, id: r.targetId },
    stage: r.stage as DealDto['stage'],
    stageAt: r.stageAt.toISOString(),
    price: { amountCents: r.priceCents, currency: r.currency },
    terms: {
      commissionBp: r.commissionBp,
      commissionFixed:
        r.commissionFixedCents !== null
          ? { amountCents: r.commissionFixedCents, currency: r.commissionCurrency ?? r.currency }
          : null,
      splitBp: r.splitBp,
      includesVat: r.commissionIncludesVat,
      snapshotAt: r.termsAt.toISOString(),
    },
    commission: {
      totalCents: r.commissionTotalCents,
      introducerShareCents: r.introducerShareCents,
      ownerShareCents: r.ownerShareCents,
      currency: r.currency,
      includesVat: r.commissionIncludesVat,
    },
    ownerConfirmedAt: iso(r.ownerConfirmedAt),
    introducerConfirmedAt: iso(r.introducerConfirmedAt),
    completedAt: iso(r.completedAt),
    fellThroughAt: iso(r.fellThroughAt),
    fellThroughReason: r.fellThroughReason,
    closedBy: r.closedBy as DealDto['closedBy'],
    mediatedAt: iso(r.mediatedAt),
    mediationReason: r.mediationReason,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

interface Lookups {
  names: Map<string, string>;
  labels: TargetLabels;
  /** The listing's agent, for the owner-side listings a non-admin member may bind the agency on. */
  listingAgents: ReadonlyMap<string, string | null>;
}

/** Binding the agency (price, stage, completion): the introducer's members; on the owner's side its admins or the agent. */
function mayBind(ctx: Ctx, r: repo.DealRow, listingAgents: Lookups['listingAgents']): boolean {
  if (!can(ctx, 'mls.deals.write')) return false;
  if (r.party !== 'OWNER' || isAdmin(ctx)) return true;
  if (ctx.actor.kind !== 'user' || r.targetKind !== 'LISTING') return false;
  return listingAgents.get(r.targetId) === ctx.actor.userId;
}

/** What the moves below would take from this member now, so a screen offers only those. The moves stay the authority. */
function allowedActions(ctx: Ctx, r: repo.DealRow, bind: boolean): DealAction[] {
  if (!can(ctx, 'mls.deals.write') || CLOSED.has(r.stage)) return [];
  const actions: DealAction[] = [];
  if (bind) {
    if ((RANK[r.stage] ?? 0) < (RANK.ARRAS ?? 0)) actions.push('ADVANCE');
    actions.push('SET_PRICE');
    actions.push(ownConfirmation(r) ? 'WITHDRAW' : 'CONFIRM');
    actions.push('FALL_THROUGH');
  }
  return actions;
}

function toDto(ctx: Ctx, r: repo.DealRow, { names, labels, listingAgents }: Lookups): DealDto {
  return {
    ...coreOf(r),
    party: r.party,
    counterpartAgencyId: r.peerAgencyId,
    counterpartName: names.get(r.peerAgencyId) ?? null,
    targetLabel: labels.get(r.targetId) ?? null,
    allowedActions: allowedActions(ctx, r, mayBind(ctx, r, listingAgents)),
  };
}

/** Names and labels for a page: two statements; a third only for a non-admin owner member with open listing deals. */
async function lookupsFor(ctx: Ctx, rows: readonly repo.DealRow[]): Promise<Lookups> {
  if (rows.length === 0) return { names: new Map(), labels: new Map(), listingAgents: new Map() };
  const names = await agencies.networkAgencyNames(
    ctx,
    rows.map((r) => r.peerAgencyId),
  );
  const labels = await targetLabels(
    ctx,
    rows.map((r) => ({ kind: r.targetKind as RegistrationTargetKind, id: r.targetId })),
  );
  const asked =
    can(ctx, 'mls.deals.write') && !isAdmin(ctx)
      ? rows
          .filter((r) => r.party === 'OWNER' && r.targetKind === 'LISTING' && !CLOSED.has(r.stage))
          .map((r) => r.targetId)
      : [];
  const listingAgents = await properties.ownListingAgents(ctx.tx, ctx.tenant.agencyId, asked);
  return { names, labels, listingAgents };
}

const dtoOf = async (ctx: Ctx, r: repo.DealRow) => toDto(ctx, r, await lookupsFor(ctx, [r]));

// ---- events and audit -------------------------------------------------------------------------------------------------

async function changed(ctx: Ctx, r: repo.DealRow, action: Action): Promise<void> {
  await emit(
    ctx.tx,
    mlsEvents.dealChanged({
      agencyId: ctx.tenant.agencyId,
      dealId: r.id,
      introducerAgencyId: introducerOf(r),
      ownerAgencyId: ownerOf(r),
      action,
      by: r.party,
      userId: memberUserId(ctx),
    }),
  );
}

/** Stage, price and the commission as the database computed them — never a reason's text. */
const amounts = (r: repo.DealRow) => ({
  party: r.party,
  stage: r.stage,
  priceCents: r.priceCents,
  currency: r.currency,
  commissionTotalCents: r.commissionTotalCents,
  introducerShareCents: r.introducerShareCents,
  ownerShareCents: r.ownerShareCents,
});

const auditDeal = (
  ctx: Ctx,
  type:
    | 'mls.deal.opened'
    | 'mls.deal.advanced'
    | 'mls.deal.priceChanged'
    | 'mls.deal.confirmed'
    | 'mls.deal.confirmationWithdrawn'
    | 'mls.deal.completed'
    | 'mls.deal.fellThrough',
  r: repo.DealRow,
) => compliance.audit(ctx, type, { type: 'deal', id: r.id }, amounts(r));

// ---- moves ------------------------------------------------------------------------------------------------------------

/**
 * Binding the owner agency to a price or a completion is for its admins or the listing's own agent (as accepting a
 * viewing's terms); the introducer's members bind theirs.
 */
async function assertMayBind(ctx: Ctx, r: { party: repo.Party; targetKind: string; targetId: string }): Promise<void> {
  if (r.party !== 'OWNER' || isAdmin(ctx)) return;
  if (r.targetKind === 'LISTING') {
    const agents = await properties.ownListingAgents(ctx.tx, ctx.tenant.agencyId, [r.targetId]);
    if (agents.get(r.targetId) === memberUserId(ctx)) return;
  }
  throw new AppError('FORBIDDEN');
}

/** A viewing request carries a deal once the owner accepted its terms: scheduled within them, or attended. */
function eligible(v: viewings.ViewingRow, now: Date): boolean {
  if (v.ownerAcceptedAt === null) return false;
  if (v.status === 'SCHEDULED') return v.termsValidUntil.getTime() > now.getTime();
  return v.status === 'COMPLETED' && v.outcome === 'ATTENDED';
}

/** A refusal of the insert guard (SQLSTATE 42501): the database's clock or state says the viewing cannot carry it. */
function isGuardRefusal(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '42501') return true;
  }
  return false;
}

/**
 * `POST /v1/mls/deals`: either party opens the deal of an accepted viewing request at the offered price; the terms
 * snapshot is the request's. One live deal per viewing request: the live one answers a repeat (`created: false`). ≤ 9
 * statements (lock, viewing, live deal, agent, insert with the peer's copy, audit, outbox, names, labels).
 */
export async function openDeal(ctx: Ctx, input: CreateDealBody): Promise<{ deal: DealDto; created: boolean }> {
  assertCan(ctx, 'mls.deals.write');
  const agencyId = ctx.tenant.agencyId;
  await advisoryLock(ctx.tx, `mls.viewing:${input.viewingRequestId}`);
  const v = await viewings.sideRow(ctx.tx, agencyId, input.viewingRequestId);
  if (!v) throw new AppError('VIEWING_REQUEST_NOT_FOUND');
  const live = await repo.liveDealOf(ctx.tx, agencyId, v.id);
  if (live) return { deal: await dtoOf(ctx, live), created: false };
  if (!eligible(v, clock.now())) throw new AppError('DEAL_VIEWING_NOT_ELIGIBLE');
  const party: repo.Party = v.side;
  await assertMayBind(ctx, { party, targetKind: v.targetKind, targetId: v.targetId });
  assertCurrency(v, input.price);
  const row = await ctx.tx
    .transaction((sp) =>
      repo.insertDeal(sp, {
        id: newId(),
        agencyId,
        party,
        peerAgencyId: party === 'OWNER' ? v.introducerAgencyId : v.ownerAgencyId,
        viewingRequestId: v.id,
        targetKind: v.targetKind,
        targetId: v.targetId,
        commissionBp: v.commissionBp,
        commissionFixedCents: v.commissionFixedCents,
        commissionCurrency: v.commissionCurrency,
        splitBp: v.splitBp,
        commissionIncludesVat: v.commissionIncludesVat,
        termsAt: v.termsAt,
        priceCents: input.price.amountCents,
        currency: input.price.currency,
      }),
    )
    .catch((err: unknown) => {
      if (isUniqueViolation(err, 'deals_viewing_open_uq') || isUniqueViolation(err, 'deals_pk')) refuse('changed');
      if (isGuardRefusal(err)) throw new AppError('DEAL_VIEWING_NOT_ELIGIBLE');
      throw err;
    });
  await auditDeal(ctx, 'mls.deal.opened', row);
  await changed(ctx, row, 'OPENED');
  return { deal: await dtoOf(ctx, row), created: true };
}

/** The caller's copy under the deal's advisory lock (both parties' moves and staff mediation take it); open only. */
async function lockedOpen(ctx: Ctx, id: string): Promise<repo.DealRow> {
  assertCan(ctx, 'mls.deals.write');
  await advisoryLock(ctx.tx, `mls.deal:${id}`);
  const row = await repo.dealOf(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('DEAL_NOT_FOUND');
  if (CLOSED.has(row.stage)) refuse('closed');
  return row;
}

async function update(ctx: Ctx, r: repo.DealRow, patch: repo.DealPatch): Promise<repo.DealRow> {
  return (await repo.updateDeal(ctx.tx, r, patch)) ?? refuse('changed');
}

/** `POST /v1/mls/deals/:id/advance`: forward to `RESERVATION` or `ARRAS` (skipping one is allowed; never back). */
export async function advanceDeal(ctx: Ctx, id: string, input: AdvanceDealBody): Promise<DealDto> {
  const r = await lockedOpen(ctx, id);
  const from = RANK[r.stage] ?? 0;
  const to = RANK[input.stage] ?? 0;
  if (to === from) refuse('unchanged');
  if (to < from) refuse('backwards');
  await assertMayBind(ctx, r);
  const next = await update(ctx, r, { stage: input.stage });
  await auditDeal(ctx, 'mls.deal.advanced', next);
  await changed(ctx, next, 'ADVANCED');
  return dtoOf(ctx, next);
}

/** `POST /v1/mls/deals/:id/price`: the agreed price changed; the guard clears both sides' confirmations. Audited. */
export async function setDealPrice(ctx: Ctx, id: string, input: SetDealPriceBody): Promise<DealDto> {
  const r = await lockedOpen(ctx, id);
  if (r.priceCents === input.price.amountCents && r.currency === input.price.currency) refuse('unchanged');
  await assertMayBind(ctx, r);
  assertCurrency(r, input.price);
  const next = await update(ctx, r, { priceCents: input.price.amountCents, currency: input.price.currency });
  await auditDeal(ctx, 'mls.deal.priceChanged', next);
  await changed(ctx, next, 'PRICE_CHANGED');
  return dtoOf(ctx, next);
}

/**
 * `POST /v1/mls/deals/:id/confirm`: the caller's side confirms the completion at the price it saw — the handshake. The
 * second side's confirmation completes the deal (`COMPLETION`, then immutable but for staff mediation). Audited.
 */
export async function confirmDeal(ctx: Ctx, id: string, input: ConfirmDealBody): Promise<DealDto> {
  const r = await lockedOpen(ctx, id);
  if (r.priceCents !== input.price.amountCents || r.currency !== input.price.currency) refuse('price_changed');
  if (ownConfirmation(r)) refuse('confirmed');
  await assertMayBind(ctx, r);
  const userId = memberUserId(ctx);
  const completes = peerConfirmation(r) !== null;
  const next = await update(ctx, r, {
    ...(r.party === 'OWNER' ? { ownerConfirmedBy: userId } : { introducerConfirmedBy: userId }),
    ...(completes ? { stage: 'COMPLETION' } : {}),
  });
  await auditDeal(ctx, 'mls.deal.confirmed', next);
  if (completes) await auditDeal(ctx, 'mls.deal.completed', next);
  await changed(ctx, next, completes ? 'COMPLETED' : 'CONFIRMED');
  return dtoOf(ctx, next);
}

/** `POST /v1/mls/deals/:id/withdraw`: the caller's side takes its confirmation back (before the deal completes). */
export async function withdrawDealConfirmation(ctx: Ctx, id: string): Promise<DealDto> {
  const r = await lockedOpen(ctx, id);
  if (!ownConfirmation(r)) refuse('not_confirmed');
  await assertMayBind(ctx, r);
  const next = await update(ctx, r, r.party === 'OWNER' ? { ownerConfirmedBy: null } : { introducerConfirmedBy: null });
  await auditDeal(ctx, 'mls.deal.confirmationWithdrawn', next);
  await changed(ctx, next, 'WITHDRAWN');
  return dtoOf(ctx, next);
}

/**
 * `POST /v1/mls/deals/:id/fall-through`: either party closes an open deal for good, with a reason — on the owner's side
 * its admins or the listing's agent (only staff reopen it). Audited (not the reason).
 */
export async function fallThroughDeal(ctx: Ctx, id: string, input: FallThroughDealBody): Promise<DealDto> {
  const r = await lockedOpen(ctx, id);
  await assertMayBind(ctx, r);
  const next = await update(ctx, r, { stage: 'FELL_THROUGH', fellThroughReason: input.reason, closedBy: r.party });
  await auditDeal(ctx, 'mls.deal.fellThrough', next);
  await changed(ctx, next, 'FELL_THROUGH');
  return dtoOf(ctx, next);
}

// ---- reads ------------------------------------------------------------------------------------------------------------

/** `GET /v1/mls/deals/:id`: the deal as the caller's side holds it. */
export async function getDeal(ctx: Ctx, id: string): Promise<DealDto> {
  assertCan(ctx, 'mls.deals.read');
  const r = await repo.dealOf(ctx.tx, ctx.tenant.agencyId, id);
  if (!r) throw new AppError('DEAL_NOT_FOUND');
  return dtoOf(ctx, r);
}

/** `GET /v1/mls/deals`: the agency's deals, both sides, newest first (keyset, ≤ 100). ≤ 4 statements. */
export async function listDeals(ctx: Ctx, query: ListDealsQuery): Promise<DealPage> {
  assertCan(ctx, 'mls.deals.read');
  const rows = await repo.dealPage(ctx.tx, ctx.tenant.agencyId, {
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
    stage: query.stage,
  });
  const lookups = await lookupsFor(ctx, rows.slice(0, query.limit));
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdMs, id: r.id }),
    (r) => toDto(ctx, r, lookups),
  );
}

// ---- staff mediation --------------------------------------------------------------------------------------------------

async function staffDto(ctx: StaffCtx, r: repo.DealRow): Promise<StaffDealDto> {
  const names = await agencies.agencyNames(ctx, [ownerOf(r), introducerOf(r)]);
  return {
    ...coreOf(r),
    ownerAgency: { id: ownerOf(r), name: names.get(ownerOf(r)) ?? '' },
    introducerAgency: { id: introducerOf(r), name: names.get(introducerOf(r)) ?? '' },
  };
}

/** `GET /v1/staff/deals/:id`: a deal with both parties (every staff role). */
export async function getStaffDeal(ctx: StaffCtx, id: string): Promise<StaffDealDto> {
  assertStaffCan(ctx, 'staff.mls.read');
  const r = await repo.staffDealOf(ctx.tx, id);
  if (!r) throw new AppError('DEAL_NOT_FOUND');
  return staffDto(ctx, r);
}

/**
 * `POST /v1/staff/deals/:id/mediate`: data ops and super admins settle a dispute — the stage (any, also back or out of a
 * closed one) and / or the price, with a reason both parties see. The only change a completed or fallen-through deal
 * takes. Leaving `COMPLETION`, or a new price, clears the handshake (the parties confirm again); a mediated completion
 * keeps the confirmations it has. Audited for both agencies (`staff.mls.dealMediated`: stage and price before and
 * after), and both are told (`mls.deal.changed`, one per agency). On the owner's copy; the sync copies it.
 */
export async function mediateDeal(ctx: StaffCtx, id: string, input: MediateDealBody): Promise<StaffDealDto> {
  assertStaffCan(ctx, 'staff.mls.mediate');
  await advisoryLock(ctx.tx, `mls.deal:${id}`);
  const r = await repo.staffDealOf(ctx.tx, id);
  if (!r) throw new AppError('DEAL_NOT_FOUND');
  const stage = input.stage ?? r.stage;
  const price = input.price ?? { amountCents: r.priceCents, currency: r.currency };
  const repriced = price.amountCents !== r.priceCents || price.currency !== r.currency;
  if (stage === r.stage && !repriced) refuse('unchanged');
  assertCurrency(r, price);
  // the database's clock, as the guard's `mediated_at`
  const now = sql`now()`;
  // a new price, or any move out of a closed stage (a reopened completion or fall-through), needs a new handshake
  const keepHandshake = !repriced && (stage === r.stage || !CLOSED.has(r.stage));
  const fell = stage === 'FELL_THROUGH';
  const next = await repo
    .mediateDeal(ctx.tx, r, {
      stage,
      priceCents: price.amountCents,
      currency: price.currency,
      ownerConfirmedAt: keepHandshake ? r.ownerConfirmedAt : null,
      ownerConfirmedBy: keepHandshake ? r.ownerConfirmedBy : null,
      introducerConfirmedAt: keepHandshake ? r.introducerConfirmedAt : null,
      introducerConfirmedBy: keepHandshake ? r.introducerConfirmedBy : null,
      completedAt: stage === 'COMPLETION' ? (r.completedAt ?? now) : null,
      fellThroughAt: fell ? (r.fellThroughAt ?? now) : null,
      fellThroughReason: fell ? (r.fellThroughReason ?? input.reason) : null,
      closedBy: fell ? (r.closedBy ?? 'STAFF') : null,
      stageAt: stage === r.stage ? r.stageAt : now,
      mediatedBy: ctx.actor.userId,
      mediationReason: input.reason,
    })
    .catch((err: unknown) => {
      // reopening a fallen-through deal while the viewing has another live one
      if (isUniqueViolation(err, 'deals_viewing_open_uq')) refuse('live_deal');
      throw err;
    });
  if (!next) refuse('changed');
  const done = next as repo.DealRow;
  const metadata = {
    fromStage: r.stage,
    toStage: done.stage,
    fromPriceCents: r.priceCents,
    toPriceCents: done.priceCents,
    currency: done.currency,
    commissionTotalCents: done.commissionTotalCents,
    introducerShareCents: done.introducerShareCents,
    ownerShareCents: done.ownerShareCents,
  };
  for (const agencyId of [ownerOf(done), introducerOf(done)]) {
    await compliance.auditStaff(ctx, agencyId, 'staff.mls.dealMediated', { type: 'deal', id: done.id }, metadata);
    await emit(
      ctx.tx,
      mlsEvents.dealChanged({
        agencyId,
        dealId: done.id,
        introducerAgencyId: introducerOf(done),
        ownerAgencyId: ownerOf(done),
        action: 'MEDIATED',
        by: 'STAFF',
        userId: ctx.actor.userId,
      }),
    );
  }
  return staffDto(ctx, done);
}
