import {
  type ClientProfileMatchDto,
  type ClientProfileMatchMoveDto,
  type ClientProfileMatchPage,
  type ClientProfileMatchStatus,
  ListClientProfileMatchesQuery,
} from '@inmolink/contracts';
import { CONTENT_LOCALES, DEFAULT_UI_LOCALE, FALLBACK_CONTENT_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { AppError } from '@inmolink/platform/errors';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { decodeCursor, encodeCursor } from '../../pagination';
import * as crm from '../crm';
import * as presentations from '../presentations';
import * as search from '../search';
import { matchingEvents } from './events';
import { explanationReasons, type MatchExplanation } from './explain';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * The review queue (R2-02d, PLAN §7 M9): what the match engine found for the agency's REVIEW profiles
 * (`PENDING_REVIEW`), for a member to approve — the listing goes into a selection for the client (an open one of the
 * contact reused, else a new one; nothing is sent: delivery is R2-02e's) — or dismiss (the learned boost counts a
 * dislike, R2-02c), and the dismissed ones to restore. Request side, under the agency's RLS; the rule is the clients'
 * (`matching.clientProfileMatches.read` / `.review` = `crm.contacts.read` / `.write`), never Client Mode or impersonating
 * staff. Matches of a merged or erased contact are not shown or moved.
 *
 * **Still offerable** (R2-02b Decision 7): before a match is shown or approved, its listing is checked against the read
 * models the caller's RLS shows (`search.offerableListingCards`: ACTIVE, the agency's own or shared with it now). A
 * match that fails is left out. Only a pending match of the agency's **own** listing is marked `EXPIRED` (the agency
 * itself withdrew it: final); a network listing that is not offerable now may be so again (the owner re-shares it, the
 * caller's agency is verified again), so it is only left out — another agency toggling its sharing cannot wipe the
 * queue (security review). A dismissed match is never expired (the client's "no" still teaches the boost).
 */

type Card = ClientProfileMatchDto['card'];

/** `GET /v1/client-profile-matches`: newest first (keyset, ≤ 100), agency-wide or one contact's or profile's. ≤ 7 statements. */
export async function listClientProfileMatches(
  ctx: Ctx,
  raw: ListClientProfileMatchesQuery,
): Promise<ClientProfileMatchPage> {
  assertCan(ctx, 'matching.clientProfileMatches.read');
  const q = ListClientProfileMatchesQuery.parse(raw);
  const cursor = decodeCursor(q.cursor);
  const agencyId = ctx.tenant.agencyId;
  if (q.contactId && !(await crm.openContactExists(ctx.tx, agencyId, q.contactId))) {
    throw new AppError('CONTACT_NOT_FOUND');
  }
  if (q.profileId) {
    const p = await repo.clientProfileOf(ctx.tx, agencyId, q.profileId);
    if (!p || !(await crm.openContactExists(ctx.tx, agencyId, p.contactId))) {
      throw new AppError('CLIENT_PROFILE_NOT_FOUND');
    }
  }
  const rows = await repo.reviewQueuePage(ctx.tx, {
    agencyId,
    status: q.status,
    profileId: q.profileId,
    contactId: q.contactId,
    cursor,
    limit: q.limit,
  });
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > q.limit && last ? encodeCursor({ at: last.createdAt, id: last.id, atUs: last.atUs }) : null;
  if (page.length === 0) return { items: [], nextCursor };

  const cards = await search.offerableListingCards(
    ctx.tx,
    agencyId,
    page.map((r) => r.listingId),
    ctx.locale,
  );
  await repo.expireMatches(
    ctx.tx,
    agencyId,
    page
      .filter((r) => r.status === 'PENDING_REVIEW' && r.listingAgencyId === agencyId && !cards.has(r.listingId))
      .map((r) => r.id),
  );
  const names = await crm.openContactNames(
    ctx.tx,
    agencyId,
    page.map((r) => r.contactId),
  );
  const items: ClientProfileMatchDto[] = [];
  for (const r of page) {
    const offer = cards.get(r.listingId);
    const contact = names.get(r.contactId);
    if (!offer || !contact) continue;
    items.push(toDto(ctx, r, offer, contact));
  }
  return { items, nextCursor };
}

function toDto(
  ctx: Ctx,
  r: repo.QueueRow,
  offer: { card: Card; network: boolean },
  contact: { firstName: string | null; lastName: string | null },
): ClientProfileMatchDto {
  return {
    id: r.id,
    profileId: r.profileId,
    contact: { id: r.contactId, firstName: contact.firstName, lastName: contact.lastName },
    status: r.status as ClientProfileMatchStatus,
    score: Math.round(r.totalScore * 1000) / 1000,
    network: offer.network,
    card: offer.card,
    explanation: explanationReasons(r.explanation as MatchExplanation, ctx.locale),
    selectionId: r.selectionId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * The match, locked until the transaction ends, if its contact is still an open contact of the agency. `lockContact`
 * (approve): the contact is locked too (`crm.lockOpenContact`), so a merge or erasure of it waits for the selection
 * this approval writes for it, and two approvals for one contact run one after the other (one draft, no lost item).
 */
async function lockOpenMatch(ctx: Ctx, id: string, lockContact = false): Promise<repo.MoveRow> {
  const m = await repo.lockMatch(ctx.tx, ctx.tenant.agencyId, id);
  const open = lockContact ? crm.lockOpenContact : crm.openContactExists;
  if (!m || !(await open(ctx.tx, ctx.tenant.agencyId, m.contactId))) {
    throw new AppError('CLIENT_PROFILE_MATCH_NOT_FOUND');
  }
  return m;
}

const offerable = async (ctx: Ctx, listingId: string) =>
  (await search.offerableListingCards(ctx.tx, ctx.tenant.agencyId, [listingId], ctx.locale)).has(listingId);

const moved = (
  id: string,
  status: ClientProfileMatchStatus,
  selectionId: string | null,
): ClientProfileMatchMoveDto => ({
  id,
  status,
  selectionId,
});

/** The client's language for a new selection: the contact's when it is a content locale, else the caller's, else the fallback. */
function selectionLocale(ctx: Ctx, language: string | null | undefined): string {
  const content = CONTENT_LOCALES as readonly string[];
  if (language && content.includes(language)) return language;
  return content.includes(ctx.locale) ? ctx.locale : FALLBACK_CONTENT_LOCALE;
}

/**
 * The selection an approval adds the listing to: the one the contact's last approval went into while it is still a
 * draft — live, never viewed by the client, room for one more — else a new one for the contact, in the client's
 * language (its link is not shown here: the agent shares it from the selection, R2-02e sends it).
 */
async function addToSelection(ctx: Ctx, contactId: string, listingId: string): Promise<string> {
  const [lastId] = await repo.approvedSelectionsOfContact(ctx.tx, ctx.tenant.agencyId, contactId, 1);
  if (lastId) {
    const r = await presentations.addToDraftSelection(ctx, { selectionId: lastId, contactId, targetId: listingId });
    if (r !== 'closed') return lastId;
  }
  const contact = (await crm.openContactNames(ctx.tx, ctx.tenant.agencyId, [contactId])).get(contactId);
  const locale = selectionLocale(ctx, contact?.language);
  const t = translator(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE, 'contacts');
  return presentations.createDraftSelection(ctx, {
    contactId,
    title: t('matchQueue.selectionTitle'),
    locale,
    targetId: listingId,
  });
}

/**
 * `POST /v1/client-profile-matches/:id/approve`: a pending match's listing goes into a selection for the client
 * (`APPROVED`, nothing sent). An own listing that can no longer be offered: the match is `EXPIRED` instead (answered,
 * not an error, so the mark stays); a network one: `CLIENT_PROFILE_MATCH_EXPIRED`, nothing written (it may come back).
 */
export async function approveClientProfileMatch(ctx: Ctx, id: string): Promise<ClientProfileMatchMoveDto> {
  assertCan(ctx, 'matching.clientProfileMatches.review');
  const m = await lockOpenMatch(ctx, id, true);
  if (m.status !== 'PENDING_REVIEW') throw new AppError('CLIENT_PROFILE_MATCH_STATE', { status: m.status });
  if (!(await offerable(ctx, m.listingId))) {
    if (m.listingAgencyId !== ctx.tenant.agencyId) throw new AppError('CLIENT_PROFILE_MATCH_EXPIRED');
    await repo.expireMatches(ctx.tx, ctx.tenant.agencyId, [m.id]);
    return moved(m.id, 'EXPIRED', null);
  }
  const selectionId = await addToSelection(ctx, m.contactId, m.listingId);
  await repo.moveMatch(ctx.tx, ctx.tenant.agencyId, m.id, 'APPROVED', selectionId);
  return moved(m.id, 'APPROVED', selectionId);
}

const dismissed = (ctx: Ctx, m: repo.MoveRow) =>
  emit(
    ctx.tx,
    matchingEvents.clientProfileMatchDismissed({ matchId: m.id, profileId: m.profileId, listingId: m.listingId }),
  );

/**
 * `POST /v1/client-profile-matches/:id/dismiss`: a pending match is turned down (`DISMISSED`, `updated_at` now) and
 * `matching.clientProfileMatch.dismissed` is emitted in the same transaction (the learned boost's dislike, R2-02c).
 */
export async function dismissClientProfileMatch(ctx: Ctx, id: string): Promise<ClientProfileMatchMoveDto> {
  assertCan(ctx, 'matching.clientProfileMatches.review');
  const m = await lockOpenMatch(ctx, id);
  if (m.status !== 'PENDING_REVIEW') throw new AppError('CLIENT_PROFILE_MATCH_STATE', { status: m.status });
  await repo.moveMatch(ctx.tx, ctx.tenant.agencyId, m.id, 'DISMISSED');
  await dismissed(ctx, m);
  return moved(m.id, 'DISMISSED', null);
}

/**
 * `POST /v1/client-profile-matches/:id/restore`: a dismissed match waits for review again (`PENDING_REVIEW`,
 * `updated_at` now); the same event is emitted, and R2-02c's job takes the dislike back. A listing that can no longer
 * be offered stays dismissed (`CLIENT_PROFILE_MATCH_EXPIRED`).
 */
export async function restoreClientProfileMatch(ctx: Ctx, id: string): Promise<ClientProfileMatchMoveDto> {
  assertCan(ctx, 'matching.clientProfileMatches.review');
  const m = await lockOpenMatch(ctx, id);
  if (m.status !== 'DISMISSED') throw new AppError('CLIENT_PROFILE_MATCH_STATE', { status: m.status });
  if (!(await offerable(ctx, m.listingId))) throw new AppError('CLIENT_PROFILE_MATCH_EXPIRED');
  await repo.moveMatch(ctx.tx, ctx.tenant.agencyId, m.id, 'PENDING_REVIEW');
  await dismissed(ctx, m);
  return moved(m.id, 'PENDING_REVIEW', null);
}
