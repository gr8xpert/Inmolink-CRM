/**
 * mls viewing requests (S11-02, PLAN §3 #9, §7 M10): request → accept / decline / reschedule → scheduled → outcome,
 * with the target's commission terms as a snapshot both sides accept. `(ctx: Ctx, input) → DTO`; authorize with
 * `assertCan`, read and write through `./viewings-repo`, emit outbox events in the same transaction.
 *
 * - **The two sides.** The introducer (who registered the client, S11-01) holds `viewing_requests`, the owner of the
 *   listing or development its copy; each changes only its own row, and the definer triggers keep the other in step in
 *   the same statement. The owner never sees the client: no registration, contact or any of the client's details.
 * - **The terms.** Read from the target as the introducer's RLS shows it when requesting — the listing's commission
 *   (percentage or fixed amount), split and VAT flag, or a development's commission and its own split (S17-F5: 5000
 *   unless the owner set another) — and valid until the registration ends. The introducer accepts them by requesting,
 *   the owner by accepting the request or proposing another time; from then on `viewing_terms_guard` refuses any change, whatever the role.
 * - **Answers.** The side awaited accepts or declines the time on the table; either side proposes another time (the
 *   other must answer it), cancels, or — after the scheduled time — records the outcome. One request at a time:
 *   every transition takes the request's advisory lock, then reads its own row.
 * - **Expiry.** An unanswered proposal lapses after the configured days (`viewingRequestExpiryDays`), or at the proposed
 *   time if sooner; the expiry job closes it and both sides are notified.
 * - **PDF.** The accepted-terms PDF is the PDF service's (S12-05): when the owner accepts, `prepareViewingTermsPdf` (a job
 *   on `mls.viewing.changed` with `termsAccepted`) reads the terms as accepted and queues the render; `viewingTerms`
 *   answers the terms, their audit trail and, once both sides accepted, a short signed link to the PDF.
 */
import type {
  CreateViewingRequestBody,
  ListViewingRequestsQuery,
  RegistrationTargetKind,
  RescheduleViewingBody,
  ViewingAction,
  ViewingOutcomeBody,
  ViewingRequestDto,
  ViewingRequestPage,
  ViewingTermsDocumentDto,
  ViewingTermsDto,
} from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { type EventMeta, type EventPayload, emit } from '@inmolink/platform/outbox';
import { type Ctx, type CtxRunner, memberUserId } from '../../context';
import { advisoryLock, idempotencyOf, isUniqueViolation, keyReusedOn, replayOf } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as developments from '../developments';
import * as documents from '../documents';
import * as identity from '../identity';
import * as notifications from '../notifications';
import * as properties from '../properties';
import * as search from '../search';
import { viewingRequestExpiryDays } from './config';
import { mlsEvents } from './events';
import { type TargetLabels, targetLabels } from './labels';
import { assertCan, can } from './policy';
import * as repo from './viewings-repo';

const DAY_MS = 86_400_000;

type Action = EventPayload<typeof mlsEvents.viewingChanged>['action'];

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const other = (side: repo.Side): repo.Side => (side === 'OWNER' ? 'INTRODUCER' : 'OWNER');

/** A fixed commission always has its currency (`<table>_terms_ck`). */
function currencyOf(r: repo.ViewingRow): string {
  if (!r.commissionCurrency) throw new Error(`mls: viewing request ${r.id} has a fixed commission without a currency`);
  return r.commissionCurrency;
}

/** The terms as the caller's side sees them: the counterpart agency's member ids are not the caller's business. */
function termsOf(r: repo.ViewingRow): ViewingTermsDto {
  return {
    commissionBp: r.commissionBp,
    commissionFixed:
      r.commissionFixedCents !== null ? { amountCents: r.commissionFixedCents, currency: currencyOf(r) } : null,
    splitBp: r.splitBp,
    includesVat: r.commissionIncludesVat,
    validUntil: r.termsValidUntil.toISOString(),
    snapshotAt: r.termsAt.toISOString(),
    introducerAcceptedAt: r.introducerAcceptedAt.toISOString(),
    introducerAcceptedByUserId: r.side === 'INTRODUCER' ? r.introducerAcceptedBy : null,
    ownerAcceptedAt: iso(r.ownerAcceptedAt),
    ownerAcceptedByUserId: r.side === 'OWNER' ? r.ownerAcceptedBy : null,
    accepted: r.ownerAcceptedAt !== null,
  };
}

interface Lookups {
  names: Map<string, string>;
  labels: TargetLabels;
  /** The listing's agent, for the listings a non-admin owner member may be asked to answer for. */
  listingAgents: ReadonlyMap<string, string | null>;
}

const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);
const isAdmin = (ctx: Ctx) => ctx.actor.kind === 'user' && ADMIN_ROLES.has(ctx.actor.role);
const isOpen = (r: repo.ViewingRow) => r.status === 'REQUESTED' || r.status === 'SCHEDULED';

/** `assertMayBind` as a flag, from the lookups: no statement per row. */
function mayBindRow(ctx: Ctx, r: repo.ViewingRow, listingAgents: Lookups['listingAgents']): boolean {
  if (!can(ctx, 'mls.viewings.write')) return false;
  if (r.side !== 'OWNER' || isAdmin(ctx)) return true;
  if (ctx.actor.kind !== 'user' || r.targetKind !== 'LISTING') return false;
  return listingAgents.get(r.targetId) === ctx.actor.userId;
}

/**
 * S17-F56: what the transitions below would take from this member now, so a screen offers only those. Same rules, same
 * clock (`lapsed` and `due` are the database's). The transitions stay the authority.
 */
function allowedActions(ctx: Ctx, r: repo.ViewingRow, mayBind: boolean): ViewingAction[] {
  if (!can(ctx, 'mls.viewings.write') || !isOpen(r) || r.lapsed) return [];
  const actions: ViewingAction[] = [];
  const answering = r.status === 'REQUESTED' && r.awaiting === r.side;
  const due = r.status === 'SCHEDULED' && r.due;
  if (due) actions.push('OUTCOME');
  if (answering && mayBind) actions.push('ACCEPT');
  if (answering) actions.push('DECLINE');
  // a new time must fall inside the terms (`proposedStart`)
  if (!due && mayBind && r.termsValidUntil.getTime() > clock.now().getTime()) actions.push('RESCHEDULE');
  actions.push('CANCEL');
  return actions;
}

function toDto(ctx: Ctx, r: repo.ViewingRow, { names, labels, listingAgents }: Lookups): ViewingRequestDto {
  const mayBind = mayBindRow(ctx, r, listingAgents);
  const counterpart = r.side === 'INTRODUCER' ? r.ownerAgencyId : r.introducerAgencyId;
  return {
    id: r.id,
    side: r.side,
    counterpartAgencyId: counterpart,
    counterpartName: names.get(counterpart) ?? null,
    registrationId: r.registrationId,
    contactId: r.contactId,
    target: { kind: r.targetKind as RegistrationTargetKind, id: r.targetId },
    targetLabel: labels.get(r.targetId) ?? null,
    status: r.status as ViewingRequestDto['status'],
    awaiting: r.awaiting as ViewingRequestDto['awaiting'],
    proposedStartAt: r.proposedStartAt.toISOString(),
    scheduledAt: iso(r.scheduledAt),
    expiresAt: iso(r.expiresAt),
    outcome: r.outcome as ViewingRequestDto['outcome'],
    outcomeAt: iso(r.outcomeAt),
    closedBy: r.closedBy as ViewingRequestDto['closedBy'],
    terms: termsOf(r),
    mayBind,
    allowedActions: allowedActions(ctx, r, mayBind),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * The counterpart agencies' names and the targets' labels for a page: two statements, whatever the page size. A third
 * (S17-F56) only for an owner member who is not an admin, when an open request of a listing is on the page: its agent.
 */
async function lookupsFor(ctx: Ctx, rows: readonly repo.ViewingRow[]): Promise<Lookups> {
  if (rows.length === 0) return { names: new Map(), labels: new Map(), listingAgents: new Map() };
  const ids = rows.map((r) => (r.side === 'INTRODUCER' ? r.ownerAgencyId : r.introducerAgencyId));
  const names = await agencies.networkAgencyNames(ctx, ids);
  const labels = await targetLabels(
    ctx,
    rows.map((r) => ({ kind: r.targetKind as RegistrationTargetKind, id: r.targetId })),
  );
  const asked =
    can(ctx, 'mls.viewings.write') && !isAdmin(ctx)
      ? rows.filter((r) => r.side === 'OWNER' && r.targetKind === 'LISTING' && isOpen(r)).map((r) => r.targetId)
      : [];
  const listingAgents = await properties.ownListingAgents(ctx.tx, ctx.tenant.agencyId, asked);
  return { names, labels, listingAgents };
}

/** When an unanswered proposal lapses: the configured days from now, or the proposed time if sooner. */
const expiryOf = (proposed: Date, now: Date): Date =>
  new Date(Math.min(now.getTime() + viewingRequestExpiryDays() * DAY_MS, proposed.getTime()));

/** A proposed start: in the future, and before the terms (the registration) end. */
function proposedStart(raw: string, validUntil: Date, now: Date): Date {
  const at = new Date(raw);
  if (at.getTime() <= now.getTime()) {
    throw new AppError('VALIDATION_FAILED', { field: 'proposedStartAt', reason: 'past' });
  }
  if (at.getTime() > validUntil.getTime()) {
    throw new AppError('VALIDATION_FAILED', { field: 'proposedStartAt', reason: 'after_registration' });
  }
  return at;
}

interface Snapshot {
  ownerAgencyId: string;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  commissionCurrency: string | null;
  splitBp: number;
  commissionIncludesVat: boolean;
}

/**
 * The target's own terms, as the introducer's RLS shows it (the network policy decides): never a default of this
 * module's — a target without a commission or a split has no snapshot to agree (`VIEWING_TERMS_INCOMPLETE`).
 */
async function termsSnapshot(ctx: Ctx, kind: string, id: string): Promise<Snapshot> {
  if (kind === 'LISTING') {
    const [t] = await properties.networkListingTerms(ctx, [id]);
    if (!t) throw new AppError('REGISTRATION_TARGET_NOT_FOUND');
    const pct = t.commissionBp !== null;
    if ((!pct && t.commissionFixedCents === null) || t.splitBp === null) throw new AppError('VIEWING_TERMS_INCOMPLETE');
    return {
      ownerAgencyId: t.agencyId,
      commissionBp: pct ? t.commissionBp : null,
      commissionFixedCents: pct ? null : t.commissionFixedCents,
      commissionCurrency: pct ? null : t.currency,
      splitBp: t.splitBp,
      commissionIncludesVat: t.commissionIncludesVat,
    };
  }
  const t = await developments.networkDevelopmentTerms(ctx, id);
  if (!t) throw new AppError('REGISTRATION_TARGET_NOT_FOUND');
  const pct = t.commissionBp !== null;
  if (!pct && t.commissionFixedCents === null) throw new AppError('VIEWING_TERMS_INCOMPLETE');
  return {
    ownerAgencyId: t.agencyId,
    commissionBp: pct ? t.commissionBp : null,
    commissionFixedCents: pct ? null : t.commissionFixedCents,
    commissionCurrency: pct ? null : t.commissionCurrency,
    // S17-F5: the development's own split, as network search shows it — snapshotted, so a later change leaves it.
    splitBp: t.splitBp,
    commissionIncludesVat: t.commissionIncludesVat,
  };
}

async function changed(ctx: Ctx, r: repo.ViewingRow, action: Action, termsAccepted: boolean): Promise<void> {
  await emit(
    ctx.tx,
    mlsEvents.viewingChanged({
      agencyId: ctx.tenant.agencyId,
      requestId: r.id,
      introducerAgencyId: r.introducerAgencyId,
      ownerAgencyId: r.ownerAgencyId,
      action,
      by: r.side,
      userId: memberUserId(ctx),
      termsAccepted,
    }),
  );
}

const auditTerms = (ctx: Ctx, r: repo.ViewingRow, side: repo.Side) =>
  compliance.audit(
    ctx,
    'mls.viewing.termsAccepted',
    { type: 'viewingRequest', id: r.id },
    {
      side,
      commissionBp: r.commissionBp,
      commissionFixedCents: r.commissionFixedCents,
      splitBp: r.splitBp,
      includesVat: r.commissionIncludesVat,
    },
  );

/**
 * `POST /v1/mls/viewing-requests`: the introducer asks for a viewing of the client of one of its valid registrations at
 * `proposedStartAt`, with the target's terms as the snapshot it accepts by asking. With an `Idempotency-Key`, a retry
 * within 24 h with the same body answers the first request. ≤ 10 statements (lock, replay, registration, terms, insert
 * with the owner's copy, audit, outbox, names).
 */
export async function requestViewing(
  ctx: Ctx,
  input: CreateViewingRequestBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ request: ViewingRequestDto; replayed: boolean }> {
  assertCan(ctx, 'mls.viewings.write');
  const agencyId = ctx.tenant.agencyId;
  const userId = memberUserId(ctx);
  const now = clock.now();
  const idempotency = idempotencyOf('mls.viewing', userId, opts.idempotencyKey, input);
  const prior = await replayOf(
    ctx.tx,
    idempotency,
    (since, key) => repo.requestByIdempotency(ctx.tx, agencyId, key.hash, since),
    { lock: true, now },
  );
  if (prior) return { request: toDto(ctx, prior.row, await lookupsFor(ctx, [prior.row])), replayed: true };

  // S17-F56: a new network action is earned by sharing (PLAN §2). After the replay: a retry is not a new action.
  const gate = await search.networkGate(ctx);
  if (gate.state === 'LOCKED') throw new AppError('NETWORK_GIVE_TO_GET_LOCKED', { gate });

  const registration = await repo.validRegistration(ctx.tx, agencyId, input.registrationId);
  if (!registration) throw new AppError('REGISTRATION_NOT_FOUND');
  const at = proposedStart(input.proposedStartAt, registration.expiresAt, now);
  const terms = await termsSnapshot(ctx, registration.targetKind, registration.targetId);
  // the target changed hands since the registration: its terms are not the registered owner's
  if (terms.ownerAgencyId !== registration.targetAgencyId) throw new AppError('REGISTRATION_TARGET_NOT_FOUND');

  const row = await ctx.tx
    .transaction((sp) =>
      repo.insertRequest(sp, {
        id: newId(),
        agencyId,
        ownerAgencyId: terms.ownerAgencyId,
        registrationId: registration.id,
        contactId: registration.contactId,
        requestedByUserId: userId,
        targetKind: registration.targetKind,
        targetId: registration.targetId,
        proposedStartAt: at,
        expiresAt: expiryOf(at, now),
        commissionBp: terms.commissionBp,
        commissionFixedCents: terms.commissionFixedCents,
        commissionCurrency: terms.commissionCurrency,
        splitBp: terms.splitBp,
        commissionIncludesVat: terms.commissionIncludesVat,
        termsValidUntil: registration.expiresAt,
        idempotencyHash: idempotency?.hash ?? null,
        requestHash: idempotency?.requestHash ?? null,
      }),
    )
    .catch((err: unknown) => {
      if (isUniqueViolation(err, 'viewing_requests_open_uq')) throw new AppError('VIEWING_REQUEST_OPEN');
      return keyReusedOn('viewing_requests_idempotency_uq')(err);
    });
  await auditTerms(ctx, row, 'INTRODUCER');
  await changed(ctx, row, 'REQUESTED', false);
  return { request: toDto(ctx, row, await lookupsFor(ctx, [row])), replayed: false };
}

/** The caller's side of the request, under the request's advisory lock (both sides' transitions take it). */
async function lockedSide(ctx: Ctx, id: string): Promise<repo.ViewingRow> {
  assertCan(ctx, 'mls.viewings.write');
  await advisoryLock(ctx.tx, `mls.viewing:${id}`);
  const row = await repo.sideRow(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('VIEWING_REQUEST_NOT_FOUND');
  return row;
}

const refuse = (reason: string): never => {
  throw new AppError('VIEWING_REQUEST_STATE', { reason });
};

/** Open: requested or scheduled, and — when requested — not past its expiry by the database's clock. */
function assertOpen(r: repo.ViewingRow): void {
  if (r.status !== 'REQUESTED' && r.status !== 'SCHEDULED') refuse('closed');
  if (r.lapsed) refuse('expired');
}

/**
 * Binding the owner agency to commission terms (accepting, or proposing a time — which accepts them too) is for its
 * admins or the listing's own agent; a development has no agent of its own, so its admins. Any member may decline or
 * cancel.
 */
async function assertMayBind(ctx: Ctx, r: repo.ViewingRow): Promise<void> {
  if (r.side !== 'OWNER') return;
  if (isAdmin(ctx)) return;
  if (r.targetKind === 'LISTING') {
    const listing = await properties.leadTargetListing(ctx.tx, ctx.tenant.agencyId, r.targetId);
    if (listing?.ownerUserId && listing.ownerUserId === memberUserId(ctx)) return;
  }
  throw new AppError('FORBIDDEN');
}

/** The caller's row as updated, or `VIEWING_REQUEST_STATE` (`changed`) when its status moved meanwhile. */
async function update(ctx: Ctx, r: repo.ViewingRow, patch: repo.ViewingPatch): Promise<repo.ViewingRow> {
  const next = await repo.updateSide(ctx.tx, ctx.tenant.agencyId, r, patch);
  return next ?? refuse('changed');
}

async function answered(ctx: Ctx, r: repo.ViewingRow, action: Action, termsAccepted: boolean) {
  if (termsAccepted) await auditTerms(ctx, r, 'OWNER');
  await changed(ctx, r, action, termsAccepted);
  return toDto(ctx, r, await lookupsFor(ctx, [r]));
}

/**
 * `POST /v1/mls/viewing-requests/:id/accept`: the side awaited accepts the time on the table → `SCHEDULED`. The owner's
 * acceptance is also its acceptance of the terms snapshot: from then on it is immutable (both sides bound). On the
 * owner's side only its admins or the listing's agent may (`assertMayBind`).
 */
export async function acceptViewing(ctx: Ctx, id: string): Promise<ViewingRequestDto> {
  const r = await lockedSide(ctx, id);
  assertOpen(r);
  if (r.status !== 'REQUESTED') refuse('closed');
  if (r.awaiting !== r.side) refuse('not_awaiting');
  await assertMayBind(ctx, r);
  const acceptsTerms = r.side === 'OWNER' && r.ownerAcceptedAt === null;
  const next = await update(ctx, r, {
    status: 'SCHEDULED',
    awaiting: null,
    scheduledAt: r.proposedStartAt,
    ...(acceptsTerms ? { ownerAccept: { userId: memberUserId(ctx) } } : {}),
  });
  return answered(ctx, next, 'ACCEPTED', acceptsTerms);
}

/** `POST /v1/mls/viewing-requests/:id/decline`: the side awaited refuses the time on the table → `DECLINED`. */
export async function declineViewing(ctx: Ctx, id: string): Promise<ViewingRequestDto> {
  const r = await lockedSide(ctx, id);
  assertOpen(r);
  if (r.status !== 'REQUESTED') refuse('closed');
  if (r.awaiting !== r.side) refuse('not_awaiting');
  const next = await update(ctx, r, { status: 'DECLINED', awaiting: null, closedBy: r.side });
  return answered(ctx, next, 'DECLINED', false);
}

/**
 * `POST /v1/mls/viewing-requests/:id/reschedule`: either side proposes another time (a requested viewing, or a
 * scheduled one whose time has not come: `too_late`) → `REQUESTED`, awaiting the other side, with a fresh expiry. The
 * owner proposing a time accepts the terms (it agrees to the viewing; only the time is open).
 */
export async function rescheduleViewing(
  ctx: Ctx,
  id: string,
  input: RescheduleViewingBody,
): Promise<ViewingRequestDto> {
  const r = await lockedSide(ctx, id);
  const now = clock.now();
  assertOpen(r);
  if (r.status === 'SCHEDULED' && r.due) refuse('too_late');
  const at = proposedStart(input.proposedStartAt, r.termsValidUntil, now);
  await assertMayBind(ctx, r);
  const acceptsTerms = r.side === 'OWNER' && r.ownerAcceptedAt === null;
  const next = await update(ctx, r, {
    status: 'REQUESTED',
    awaiting: other(r.side),
    proposedStartAt: at,
    scheduledAt: null,
    expiresAt: expiryOf(at, now),
    ...(acceptsTerms ? { ownerAccept: { userId: memberUserId(ctx) } } : {}),
  });
  return answered(ctx, next, 'RESCHEDULED', acceptsTerms);
}

/** `POST /v1/mls/viewing-requests/:id/cancel`: either side calls off a requested or scheduled viewing → `CANCELLED`. */
export async function cancelViewing(ctx: Ctx, id: string): Promise<ViewingRequestDto> {
  const r = await lockedSide(ctx, id);
  assertOpen(r);
  const next = await update(ctx, r, { status: 'CANCELLED', awaiting: null, closedBy: r.side });
  return answered(ctx, next, 'CANCELLED', false);
}

/** `POST /v1/mls/viewing-requests/:id/outcome`: after the scheduled time, either side records it → `COMPLETED`. */
export async function recordViewingOutcome(
  ctx: Ctx,
  id: string,
  input: ViewingOutcomeBody,
): Promise<ViewingRequestDto> {
  const r = await lockedSide(ctx, id);
  if (r.status !== 'SCHEDULED') refuse(r.status === 'REQUESTED' ? 'not_scheduled' : 'closed');
  if (!r.due) refuse('too_early');
  const next = await update(ctx, r, {
    status: 'COMPLETED',
    awaiting: null,
    outcome: input.outcome,
    outcomeAt: clock.now(),
  });
  return answered(ctx, next, 'COMPLETED', false);
}

/** `GET /v1/mls/viewing-requests/:id`: the request as the caller's side holds it. */
export async function getViewingRequest(ctx: Ctx, id: string): Promise<ViewingRequestDto> {
  assertCan(ctx, 'mls.viewings.read');
  const r = await repo.sideRow(ctx.tx, ctx.tenant.agencyId, id);
  if (!r) throw new AppError('VIEWING_REQUEST_NOT_FOUND');
  const dto = toDto(ctx, r, await lookupsFor(ctx, [r]));
  // S12-F9: the introducer's copy is about its client (the owner's never is).
  if (r.side === 'INTRODUCER') {
    await compliance.auditImpersonatedRead(ctx, 'mls.clientData.read', 'viewingRequests', {
      target: { type: 'viewingRequest', id: r.id },
    });
  }
  return dto;
}

/**
 * The terms snapshot with its audit trail (who accepted, when), for either side, read in the request's transaction;
 * `viewingTerms` (`terms-pdf.ts`) adds the PDF link after it (S12-05).
 */
export async function viewingTermsDoc(
  run: CtxRunner,
  id: string,
): Promise<{ doc: ViewingTermsDocumentDto; ownerAccepted: boolean }> {
  return run(async (ctx) => {
    assertCan(ctx, 'mls.viewings.read');
    const r = await repo.sideRow(ctx.tx, ctx.tenant.agencyId, id);
    if (!r) throw new AppError('VIEWING_REQUEST_NOT_FOUND');
    return {
      doc: {
        requestId: r.id,
        introducerAgencyId: r.introducerAgencyId,
        ownerAgencyId: r.ownerAgencyId,
        target: { kind: r.targetKind as RegistrationTargetKind, id: r.targetId },
        terms: termsOf(r),
        pdfUrl: null,
      },
      ownerAccepted: r.ownerAcceptedAt !== null,
    };
  });
}

/**
 * S12-05: the accepted-terms PDF of a request whose terms the owner just accepted — read as accepted (one row, both
 * agencies' directory names, the listing's label) in the job's own `withSystem` transaction, then queued for the `pdf`
 * pool (`documents.queueViewingTermsPdf`, idempotent per request). The event's agency must be a party to the request.
 * In the owner's first language. Nothing of the client (the PDF is between the agencies).
 */
export async function prepareViewingTermsPdf(
  p: EventPayload<typeof mlsEvents.viewingChanged>,
  meta: Pick<EventMeta, 'agencyId'>,
): Promise<{ queued: boolean }> {
  const payload = await withSystem(`mls.viewingTermsPdf: request ${p.requestId}`, async (tx) => {
    const r = await repo.sideRow(tx, p.ownerAgencyId, p.requestId);
    if (!r?.ownerAcceptedAt) return null;
    if (meta.agencyId !== r.introducerAgencyId && meta.agencyId !== r.ownerAgencyId) return null;
    const names = await agencies.directoryNamesOf(tx, [r.introducerAgencyId, r.ownerAgencyId]);
    const locale = (await agencies.loadTenant(tx, r.ownerAgencyId))?.locales[0] ?? 'es';
    const label =
      r.targetKind === 'LISTING' ? (await search.listingLabels(tx, [r.targetId], locale)).get(r.targetId) : undefined;
    const terms = termsOf(r);
    return {
      requestId: r.id,
      ownerAgencyId: r.ownerAgencyId,
      locale,
      target: { ref: label?.reference ?? null, title: label?.title ?? null },
      introducerName: names.get(r.introducerAgencyId) ?? '',
      ownerName: names.get(r.ownerAgencyId) ?? '',
      commissionBp: terms.commissionBp,
      commissionFixed: terms.commissionFixed,
      splitBp: terms.splitBp,
      includesVat: terms.includesVat,
      validUntil: terms.validUntil,
      snapshotAt: terms.snapshotAt,
      introducerAcceptedAt: terms.introducerAcceptedAt,
      ownerAcceptedAt: r.ownerAcceptedAt.toISOString(),
      scheduledAt: iso(r.scheduledAt),
    };
  });
  if (!payload) return { queued: false };
  await documents.queueViewingTermsPdf(payload);
  return { queued: true };
}

/** The filters, with the agency's time zone when a day range needs it (one more query, only then). */
async function viewingFilter(ctx: Ctx, q: ListViewingRequestsQuery): Promise<repo.ViewingFilter> {
  const timeZone = q.from || q.to ? await agencies.agencyTimeZone(ctx.tx, ctx.tenant.agencyId) : undefined;
  return { status: q.status, kind: q.kind, from: q.from, to: q.to, timeZone };
}

/** `GET /v1/mls/viewing-requests`: the agency's requests as introducer, newest first, keyset (two queries). */
export async function listViewingRequests(ctx: Ctx, query: ListViewingRequestsQuery): Promise<ViewingRequestPage> {
  assertCan(ctx, 'mls.viewings.read');
  const cursor = decodeCursor(query.cursor);
  const rows = await repo.introducerPage(ctx.tx, ctx.tenant.agencyId, {
    limit: query.limit,
    filter: await viewingFilter(ctx, query),
    ...(cursor ? { cursor } : {}),
  });
  const lookups = await lookupsFor(ctx, rows.slice(0, query.limit));
  const page = toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdMs, id: r.id }),
    (r) => toDto(ctx, r, lookups),
  );
  // S12-F9: introducer-side requests are about the agency's clients.
  await compliance.auditImpersonatedRead(ctx, 'mls.clientData.read', 'viewingRequests', {
    count: page.items.length,
    filter: { status: query.status, kind: query.kind },
  });
  return page;
}

/** `GET /v1/mls/received-viewing-requests`: the owner's side — never the client. Newest first, keyset (two queries). */
export async function listReceivedViewingRequests(
  ctx: Ctx,
  query: ListViewingRequestsQuery,
): Promise<ViewingRequestPage> {
  assertCan(ctx, 'mls.viewings.read');
  const cursor = decodeCursor(query.cursor);
  const rows = await repo.ownerPage(ctx.tx, ctx.tenant.agencyId, {
    limit: query.limit,
    filter: await viewingFilter(ctx, query),
    ...(cursor ? { cursor } : {}),
  });
  const lookups = await lookupsFor(ctx, rows.slice(0, query.limit));
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdMs, id: r.id }),
    (r) => toDto(ctx, r, lookups),
  );
}

// ---- worker ------------------------------------------------------------------------------------------------------------

const EXPIRY_BATCH = 500;
/** Fair share: one introducer agency's backlog takes at most this much of a batch. */
const EXPIRY_PER_AGENCY = 100;
const EXPIRY_MAX_BATCHES = 20;

/**
 * The expiry job (`mls.expireViewingRequests`, every 15 minutes): unanswered proposals past their expiry become
 * `EXPIRED` (both copies), in batches of 500 — one transaction each, with one `mls.viewing.changed` (`by: SYSTEM`) per
 * request, so both sides are notified (`notifyViewingChange`). Idempotent: a closed request is not due any more.
 */
export async function expireViewingRequests(): Promise<{ expired: number }> {
  let expired = 0;
  for (let i = 0; i < EXPIRY_MAX_BATCHES; i++) {
    const n = await withSystem('mls.expireViewingRequests: unanswered viewing proposals', async (tx) => {
      const rows = await repo.expireDue(tx, EXPIRY_BATCH, EXPIRY_PER_AGENCY);
      await emit(
        tx,
        rows.map((r) =>
          mlsEvents.viewingChanged({
            agencyId: r.introducerAgencyId,
            requestId: r.id,
            introducerAgencyId: r.introducerAgencyId,
            ownerAgencyId: r.ownerAgencyId,
            action: 'EXPIRED',
            by: 'SYSTEM',
            userId: null,
            termsAccepted: false,
          }),
        ),
      );
      return rows.length;
    });
    expired += n;
    if (n < EXPIRY_BATCH) break;
  }
  return { expired };
}

/** Members to tell on one side: the request's member (introducer), the listing's agent (owner), else the admins. */
async function recipients(
  tx: Tx,
  side: repo.Side,
  r: NonNullable<Awaited<ReturnType<typeof repo.forNotice>>>,
  listingAgent: string | null,
): Promise<string[]> {
  const agencyId = side === 'INTRODUCER' ? r.introducerAgencyId : r.ownerAgencyId;
  const first = side === 'INTRODUCER' ? r.requestedByUserId : listingAgent;
  // the member who asked may have left the agency since: then its admins
  if (first && (await identity.activeClientMembersAmong(tx, agencyId, [first])).has(first)) return [first];
  return (await identity.listAgencyAdmins(tx, agencyId)).map((a) => a.userId).slice(0, 100);
}

/**
 * `mls.notifyViewing` (one job per `mls.viewing.changed`, job ID = the event's id): the other side's members are told
 * (`VIEWING_REQUESTED` for a new request, `VIEWING_UPDATED` otherwise); on expiry (`SYSTEM`) both sides. Across agencies,
 * so in the job's own `withSystem` transaction (`notifications.raiseNotifications`, `sourceKey` = event + side:
 * idempotent). The event's agency must be a party to the request (RLS-checked when it was written). Never the client:
 * the subject is the listing's reference, the actor the counterpart agency's directory name.
 */
export async function notifyViewingChange(
  p: EventPayload<typeof mlsEvents.viewingChanged>,
  meta: Pick<EventMeta, 'eventId' | 'agencyId' | 'createdAt'>,
): Promise<{ notified: number }> {
  return withSystem(`mls.notifyViewing: request ${p.requestId}`, async (tx) => {
    const r = await repo.forNotice(tx, p.requestId);
    if (!r || (meta.agencyId !== r.introducerAgencyId && meta.agencyId !== r.ownerAgencyId)) return { notified: 0 };
    const sides: repo.Side[] =
      p.by === 'SYSTEM' ? ['INTRODUCER', 'OWNER'] : [p.by === 'OWNER' ? 'INTRODUCER' : 'OWNER'];
    const listing =
      r.targetKind === 'LISTING' ? await properties.leadTargetListing(tx, r.ownerAgencyId, r.targetId) : null;
    const names = await agencies.directoryNamesOf(tx, [r.introducerAgencyId, r.ownerAgencyId]);
    let notified = 0;
    for (const side of sides) {
      const agencyId = side === 'INTRODUCER' ? r.introducerAgencyId : r.ownerAgencyId;
      const counterpart = side === 'INTRODUCER' ? r.ownerAgencyId : r.introducerAgencyId;
      const userIds = await recipients(tx, side, r, listing?.ownerUserId ?? null);
      if (userIds.length === 0) continue;
      const res = await notifications.raiseNotifications(tx, {
        agencyId,
        type: p.action === 'REQUESTED' ? 'VIEWING_REQUESTED' : 'VIEWING_UPDATED',
        userIds,
        params: {
          actor: names.get(counterpart) ?? '',
          subject: listing?.ref ?? `#${r.id.slice(-8)}`,
          status: p.action,
        },
        link: side === 'INTRODUCER' ? `/mls/viewings/${r.id}` : `/mls/received-viewings/${r.id}`,
        sourceKey: `${meta.eventId}:${side}`,
        at: meta.createdAt,
      });
      notified += res.notified.length;
    }
    return { notified };
  });
}
