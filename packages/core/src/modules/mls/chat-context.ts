import type { Tx } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import * as identity from '../identity';
import * as properties from '../properties';
import * as deals from './deals-repo';
import { assertCan } from './policy';
import * as repo from './viewings-repo';

/** Viewing states after which its chat thread is read-only (S11-03): declined, cancelled, expired. */
export const CLOSED_VIEWING_STATUSES: ReadonlySet<string> = new Set(['DECLINED', 'CANCELLED', 'EXPIRED']);

/**
 * S11-03 chat: the caller's side of a viewing request, as little as a thread needs — the other agency and the state
 * (`mls.viewings.read`; one or two primary-key reads). `VIEWING_REQUEST_NOT_FOUND` when the caller's agency is no party.
 */
export async function viewingCounterpart(
  ctx: Ctx,
  id: string,
): Promise<{ id: string; counterpartAgencyId: string; status: string }> {
  assertCan(ctx, 'mls.viewings.read');
  const r = await repo.sideRow(ctx.tx, ctx.tenant.agencyId, id);
  if (!r) throw new AppError('VIEWING_REQUEST_NOT_FOUND');
  return {
    id: r.id,
    counterpartAgencyId: r.side === 'INTRODUCER' ? r.ownerAgencyId : r.introducerAgencyId,
    status: r.status,
  };
}

/** What S11-03 chat needs to seat a viewing request's thread: its two agencies, who on each side, and its subject. */
export interface ViewingChatContext {
  introducerAgencyId: string;
  ownerAgencyId: string;
  status: string;
  /** Default members on each side: the member who asked (introducer), the listing's agent (owner), else the admins. */
  introducerUserIds: string[];
  ownerUserIds: string[];
  /** The listing's reference (never the client); null for a development or a listing without one. */
  subject: string | null;
}

async function membersOf(tx: Tx, agencyId: string, first: string | null): Promise<string[]> {
  // the member who asked (or the listing's agent) may have left the agency since: then its admins
  if (first && (await identity.activeClientMembersAmong(tx, agencyId, [first])).has(first)) return [first];
  return (await identity.listAgencyAdmins(tx, agencyId)).map((a) => a.userId).slice(0, 10);
}

/**
 * Worker form (app_system, `withSystem`; PATTERNS §12): the viewing request's chat context, or null when there is no
 * such request. The same members `notifyViewingChange` tells about the request.
 */
export async function viewingChatContext(tx: Tx, requestId: string): Promise<ViewingChatContext | null> {
  const r = await repo.forNotice(tx, requestId);
  if (!r) return null;
  const listing =
    r.targetKind === 'LISTING' ? await properties.leadTargetListing(tx, r.ownerAgencyId, r.targetId) : null;
  return {
    introducerAgencyId: r.introducerAgencyId,
    ownerAgencyId: r.ownerAgencyId,
    status: r.status,
    introducerUserIds: await membersOf(tx, r.introducerAgencyId, r.requestedByUserId),
    ownerUserIds: await membersOf(tx, r.ownerAgencyId, listing?.ownerUserId ?? null),
    subject: listing?.ref ?? null,
  };
}

/**
 * R2-04b chat: the caller's side of a deal, as little as a thread needs — the other party and the stage
 * (`mls.deals.read`; one primary-key read). `DEAL_NOT_FOUND` when the caller's agency is no party.
 */
export async function dealCounterpart(
  ctx: Ctx,
  id: string,
): Promise<{ id: string; counterpartAgencyId: string; stage: string }> {
  assertCan(ctx, 'mls.deals.read');
  const r = await deals.dealOf(ctx.tx, ctx.tenant.agencyId, id);
  if (!r) throw new AppError('DEAL_NOT_FOUND');
  return { id: r.id, counterpartAgencyId: r.peerAgencyId, stage: r.stage };
}

/** Who a deal's thread seats and its notifications tell, on each side, and its subject (R2-04b). */
export interface DealChatContext {
  introducerAgencyId: string;
  ownerAgencyId: string;
  stage: string;
  /** The member who asked for the viewing (introducer), the listing's agent (owner), else the admins. */
  introducerUserIds: string[];
  ownerUserIds: string[];
  /** The listing's reference (never the client); null for a development or a listing without one. */
  subject: string | null;
}

/**
 * Worker form (app_system, `withSystem`; PATTERNS §12): a deal's chat and notice context, or null when there is no
 * such deal with both parties' copies in step (the two copies name each other). The viewing request may be gone
 * (pruned with its registration, S16-F5): then the introducer's admins.
 */
export async function dealChatContext(tx: Tx, dealId: string): Promise<DealChatContext | null> {
  const copies = await deals.copiesOf(tx, dealId);
  const owner = copies.find((c) => c.party === 'OWNER');
  const introducer = copies.find((c) => c.party === 'INTRODUCER');
  if (
    !owner ||
    !introducer ||
    owner.peerAgencyId !== introducer.agencyId ||
    introducer.peerAgencyId !== owner.agencyId
  ) {
    return null;
  }
  const viewing = await repo.forNotice(tx, introducer.viewingRequestId);
  const listing =
    owner.targetKind === 'LISTING' ? await properties.leadTargetListing(tx, owner.agencyId, owner.targetId) : null;
  return {
    introducerAgencyId: introducer.agencyId,
    ownerAgencyId: owner.agencyId,
    stage: owner.stage,
    introducerUserIds: await membersOf(
      tx,
      introducer.agencyId,
      viewing && viewing.introducerAgencyId === introducer.agencyId ? viewing.requestedByUserId : null,
    ),
    ownerUserIds: await membersOf(tx, owner.agencyId, listing?.ownerUserId ?? null),
    subject: listing?.ref ?? null,
  };
}
