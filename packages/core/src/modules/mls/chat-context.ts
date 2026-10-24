import type { Tx } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import * as identity from '../identity';
import * as properties from '../properties';
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
