import {
  type DedupeClusterDto,
  type DedupeClusterPage,
  type DedupeDisputeDto,
  type DedupeDisputeKind,
  type DedupeDisputePage,
  type DedupeDisputeStatus,
  DedupeListedByInput,
  type DedupeListedByMember,
  type DedupeListedByResult,
  type DedupeListingCard,
  type DedupePairSignals,
  type DedupeReviewDto,
  type DedupeReviewMoveDto,
  type DedupeReviewPage,
  type DedupeReviewStatus,
  ListDedupeClustersQuery,
  ListDedupeDisputesQuery,
  ListDedupeReviewsQuery,
  OpenDedupeDisputeBody,
  ResolveDedupeDisputeBody,
  type StaffDedupeDisputeDto,
  type StaffDedupeDisputePage,
  StaffDedupeDisputesQuery,
} from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { type Ctx, memberUserId, type StaffCtx } from '../../context';
import { decodeCursor, encodeCursor } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as properties from '../properties';
import * as search from '../search';
import { dedupeEvents } from './events';
import { assertCan, assertStaffCan } from './policy';
import * as repo from './repo';

/**
 * The member- and staff-facing duplicate use cases (R2-03b, PLAN §10). Request side: the agency's own rows under its
 * RLS (`dedupe_reviews`, `dedupe_listing_clusters`, `dedupe_disputes`); the global cluster tables are the worker's.
 *
 * **Visibility.** Every listing shown is checked against the read models the caller's RLS shows
 * (`search.offerableListingCards`: ACTIVE, the agency's own, or another agency's shared with it now — on the network,
 * not hidden, ALL or the caller preferred, its owner listed). A review whose other listing the caller may not see is
 * left out (and cannot be decided); a cluster shows only the members the caller may see, and its "canonical" is the
 * first of those (what the agency's clients are shown, R2-03c). Other agencies are never named; private,
 * preferred-only and network-hidden listings of others never appear, not even as a count.
 *
 * **Who decides** (PLAN §2 / §3 #13 / §10): either agency involved may confirm a pair (it joins the cluster like an
 * auto-cluster score) or answer "not a duplicate" (final: no rescore clusters it again, a later confirmation does not
 * undo it). The other agency's review of the pair closes; if it disagrees with a confirmation it disputes the
 * clustering (staff decide), like any auto-clustered listing.
 */

type Card = DedupeListingCard;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function page<R extends { createdAt: Date; atUs: string }>(rows: R[], limit: number, id: (r: R) => string) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ at: last.createdAt, id: id(last), atUs: last.atUs }) : null;
  return { items, nextCursor };
}

const cardsFor = (ctx: Ctx, ids: readonly string[]) =>
  search.offerableListingCards(ctx.tx, ctx.tenant.agencyId, [...new Set(ids)], ctx.locale);

/* ------------------------------------------------------------------ the review queue */

/** `GET /v1/duplicates/reviews`: the agency's pairs of one status, newest first (keyset, ≤ 100). Two statements. */
export async function listDuplicateReviews(ctx: Ctx, raw: ListDedupeReviewsQuery): Promise<DedupeReviewPage> {
  assertCan(ctx, 'dedupe.read');
  const q = ListDedupeReviewsQuery.parse(raw);
  const rows = await repo.reviewQueuePage(ctx.tx, {
    agencyId: ctx.tenant.agencyId,
    status: q.status,
    cursor: decodeCursor(q.cursor),
    limit: q.limit,
  });
  const { items, nextCursor } = page(rows, q.limit, (r) => r.id);
  if (items.length === 0) return { items: [], nextCursor };
  const cards = await cardsFor(
    ctx,
    items.flatMap((r) => [r.listingId, r.otherListingId]),
  );
  const out: DedupeReviewDto[] = [];
  for (const r of items) {
    const own = cards.get(r.listingId);
    const other = cards.get(r.otherListingId);
    if (!own || own.network || !other) continue;
    out.push({
      id: r.id,
      status: r.status as DedupeReviewStatus,
      score: Math.round(r.score * 1000) / 1000,
      signals: r.signals as DedupePairSignals,
      listing: own.card as Card,
      other: { network: other.network, card: other.card as Card },
      decidedAt: iso(r.decidedAt),
      createdAt: r.createdAt.toISOString(),
    });
  }
  return { items: out, nextCursor };
}

/**
 * `POST /v1/duplicates/reviews/:id/confirm` · `/not-duplicate`: a member decides a pending pair of the agency; the
 * worker applies it (`dedupe.review.decided`, emitted in this transaction). Both listings must still be visible to the
 * caller. Four statements.
 */
export async function decideDuplicateReview(
  ctx: Ctx,
  id: string,
  decision: 'CONFIRMED' | 'NOT_DUPLICATE',
): Promise<DedupeReviewMoveDto> {
  assertCan(ctx, 'dedupe.review');
  const agencyId = ctx.tenant.agencyId;
  const r = await repo.lockReview(ctx.tx, agencyId, id);
  if (!r) throw new AppError('DEDUPE_REVIEW_NOT_FOUND');
  if (r.status !== 'PENDING') throw new AppError('DEDUPE_REVIEW_STATE', { status: r.status });
  const cards = await cardsFor(ctx, [r.listingId, r.otherListingId]);
  const own = cards.get(r.listingId);
  if (!own || own.network || !cards.has(r.otherListingId)) throw new AppError('DEDUPE_REVIEW_NOT_FOUND');
  if (!(await repo.decideReview(ctx.tx, agencyId, r.id, decision, memberUserId(ctx)))) {
    throw new AppError('DEDUPE_REVIEW_STATE');
  }
  await emit(ctx.tx, dedupeEvents.reviewDecided({ reviewId: r.id }));
  return { id: r.id, status: decision };
}

/* ------------------------------------------------------------------ clustered listings */

/**
 * `GET /v1/duplicates/clusters`: the agency's clustered listings, newest first (keyset, ≤ 100), each with the members
 * the caller may see in canonical order and its open dispute. Three statements.
 */
export async function listDuplicateClusters(ctx: Ctx, raw: ListDedupeClustersQuery): Promise<DedupeClusterPage> {
  assertCan(ctx, 'dedupe.read');
  const q = ListDedupeClustersQuery.parse(raw);
  const agencyId = ctx.tenant.agencyId;
  const rows = await repo.listingClustersPage(ctx.tx, { agencyId, cursor: decodeCursor(q.cursor), limit: q.limit });
  const { items, nextCursor } = page(rows, q.limit, (r) => r.listingId);
  if (items.length === 0) return { items: [], nextCursor };
  const cards = await cardsFor(
    ctx,
    items.flatMap((r) => r.memberIds),
  );
  const open = new Map(
    (
      await repo.openDisputesOf(
        ctx.tx,
        agencyId,
        items.map((r) => r.listingId),
      )
    ).map((d) => [d.listingId, d]),
  );
  const out: DedupeClusterDto[] = [];
  for (const r of items) {
    const visible = r.memberIds.flatMap((m) => {
      const c = cards.get(m);
      return c ? [{ id: m, own: !c.network, network: c.network, card: c.card as Card }] : [];
    });
    // a group the caller sees alone would tell that a listing it may not see exists
    if (visible.length < 2 || !visible.some((m) => m.id === r.listingId && m.own)) continue;
    const dispute = open.get(r.listingId);
    out.push({
      listingId: r.listingId,
      clusterId: r.clusterId,
      canonical: visible[0]?.id === r.listingId,
      via: r.via as DedupeClusterDto['via'],
      members: visible.map(({ id: _id, ...m }) => m),
      openDispute: dispute ? { id: dispute.id, kind: dispute.kind as DedupeDisputeKind } : null,
      createdAt: r.createdAt.toISOString(),
    });
  }
  return { items: out, nextCursor };
}

/* ------------------------------------------------------------------ "listed by N agencies" (R2-03c) */

/**
 * `GET /v1/duplicates/listed-by` (R2-03c, PLAN §10 "agents see listed by N agencies with each agency's terms"): for
 * each of these listings that shares a duplicate cluster with another listing the caller may see, every such member in
 * canonical order with its terms — the caller's own (no agency or network commission: its own terms are on its
 * listing), or another agency's as network search shows it (the directory name, the commission with the caller's
 * share). The members come from the read models the caller's RLS shows and are kept only while the caller may offer
 * them (`search.offerableListingCards`: ACTIVE, own or shared with it now, the owner listed); another agency's member
 * without terms or a directory name under the caller's RLS is left out, as in network search. Members the caller may
 * not see are never named or counted; a listing it may not see answers nothing. Four statements.
 */
export async function listedBy(ctx: Ctx, raw: DedupeListedByInput): Promise<DedupeListedByResult> {
  assertCan(ctx, 'dedupe.read');
  const q = DedupeListedByInput.parse({ listingIds: [...new Set(raw.listingIds)] });
  const mates = await search.visibleClusterMates(ctx.tx, q.listingIds);
  if (mates.length === 0) return { items: [] };
  const cards = await cardsFor(
    ctx,
    mates.map((m) => m.targetId),
  );
  const offered = mates.filter((m) => cards.get(m.targetId)?.network === true).map((m) => m.targetId);
  // other agencies' members only for an agency the network is open to (give-to-get, as network search: a locked one
  // sees its own members only)
  const open =
    offered.length > 0 && search.can(ctx, 'search.network') && (await search.networkGate(ctx)).state !== 'LOCKED';
  const network = open ? offered : [];
  const terms = new Map(
    (network.length > 0 ? await properties.networkListingTerms(ctx, network) : []).map((t) => [t.id, t]),
  );
  const names =
    terms.size > 0
      ? await agencies.networkAgencyNames(
          ctx,
          [...terms.values()].map((t) => t.agencyId),
        )
      : new Map<string, string>();
  const byCluster = new Map<string, { rank: number; member: DedupeListedByMember; agencyId: string }[]>();
  const clusterOf = new Map<string, string>();
  for (const m of [...mates].sort((x, y) => x.rank - y.rank || (x.targetId < y.targetId ? -1 : 1))) {
    const c = cards.get(m.targetId);
    if (!c) continue;
    const card = c.card as Card;
    const t = c.network ? terms.get(m.targetId) : undefined;
    const name = t ? names.get(t.agencyId) : undefined;
    if (c.network && (!t || name === undefined)) continue;
    const list = byCluster.get(m.clusterId) ?? [];
    list.push({
      rank: m.rank,
      agencyId: t ? t.agencyId : ctx.tenant.agencyId,
      member: {
        listingId: m.targetId,
        own: !c.network,
        canonical: false,
        reference: card.ref,
        agency: t && name !== undefined ? { id: t.agencyId, name } : null,
        price: card.price,
        commission: t
          ? search.networkCommission({
              priceCents: t.priceCents,
              priceOnRequest: t.priceOnRequest,
              currency: t.currency,
              commissionBp: t.commissionBp,
              commissionFixedCents: t.commissionFixedCents,
              commissionCurrency: t.currency,
              splitBp: t.splitBp,
              includesVat: t.commissionIncludesVat,
            })
          : null,
      },
    });
    byCluster.set(m.clusterId, list);
    clusterOf.set(m.targetId, m.clusterId);
  }
  const items: DedupeListedByResult['items'] = [];
  for (const id of q.listingIds) {
    const cluster = clusterOf.get(id);
    const members = cluster ? (byCluster.get(cluster) ?? []) : [];
    // a group the caller sees alone would tell that a listing it may not see exists
    if (members.length < 2) continue;
    // the member the caller's clients are shown: its own (best ranked) first, else the first visible in canonical order
    const shown = Math.max(
      0,
      members.findIndex((m) => m.member.own),
    );
    for (const [i, m] of members.entries()) m.member.canonical = i === shown;
    items.push({
      listingId: id,
      agencies: new Set(members.map((m) => m.agencyId)).size,
      members: members.map((m) => m.member),
    });
  }
  return { items };
}

/* ------------------------------------------------------------------ disputes (members) */

const disputeDto = (d: repo.DisputeRow): DedupeDisputeDto => ({
  id: d.id,
  listingId: d.listingId,
  clusterId: d.clusterId,
  kind: d.kind as DedupeDisputeKind,
  reason: d.reason,
  status: d.status as DedupeDisputeStatus,
  resolutionNote: d.resolutionNote,
  createdAt: d.createdAt.toISOString(),
  resolvedAt: iso(d.resolvedAt),
});

/**
 * `POST /v1/duplicates/disputes`: the agency disputes the clustering of its own clustered listing — not a duplicate of
 * the others, or it should be the canonical one (not when it already is, as far as the caller sees). The listing stays
 * in its cluster until staff decide (PLAN §10: score ≥ 0.9 clusters; agencies dispute; staff resolve). One open dispute
 * a listing. Four statements.
 */
export async function openDuplicateDispute(ctx: Ctx, raw: OpenDedupeDisputeBody): Promise<DedupeDisputeDto> {
  assertCan(ctx, 'dedupe.dispute');
  const body = OpenDedupeDisputeBody.parse(raw);
  const agencyId = ctx.tenant.agencyId;
  const row = await repo.listingClusterOf(ctx.tx, agencyId, body.listingId);
  if (!row) throw new AppError('DEDUPE_LISTING_NOT_CLUSTERED');
  // judged on what the caller sees (as `listDuplicateClusters` shows it), never on members it may not see
  const cards = await cardsFor(ctx, row.memberIds);
  const visible = row.memberIds.filter((m) => cards.has(m));
  if (visible.length < 2 || !visible.includes(row.listingId)) throw new AppError('DEDUPE_LISTING_NOT_CLUSTERED');
  if (body.kind === 'CANONICAL' && visible[0] === row.listingId) {
    throw new AppError('DEDUPE_DISPUTE_CONFLICT', { field: 'kind' });
  }
  const inserted = await repo.insertDispute(ctx.tx, {
    id: newId(),
    agencyId,
    listingId: row.listingId,
    clusterId: row.clusterId,
    kind: body.kind,
    reason: body.reason,
    openedByUserId: memberUserId(ctx),
  });
  if (!inserted) throw new AppError('DEDUPE_DISPUTE_CONFLICT');
  return disputeDto(inserted);
}

/** `GET /v1/duplicates/disputes`: the agency's disputes, newest first (keyset, ≤ 100). One statement. */
export async function listDuplicateDisputes(ctx: Ctx, raw: ListDedupeDisputesQuery): Promise<DedupeDisputePage> {
  assertCan(ctx, 'dedupe.read');
  const q = ListDedupeDisputesQuery.parse(raw);
  const rows = await repo.disputesPage(ctx.tx, {
    agencyId: ctx.tenant.agencyId,
    cursor: decodeCursor(q.cursor),
    limit: q.limit,
  });
  const { items, nextCursor } = page(rows, q.limit, (r) => r.id);
  return { items: items.map(disputeDto), nextCursor };
}

/* ------------------------------------------------------------------ disputes (staff) */

async function staffDtos(ctx: StaffCtx, rows: readonly repo.DisputeRow[]): Promise<StaffDedupeDisputeDto[]> {
  if (rows.length === 0) return [];
  const names = await agencies.agencyNames(
    ctx,
    rows.map((r) => r.agencyId),
  );
  const mates = await repo.clusterMatesOf(
    ctx.tx,
    rows.map((r) => r.listingId),
  );
  const byCluster = new Map<string, repo.MemberRow[]>();
  const clusterOf = new Map<string, string>();
  for (const m of mates) {
    byCluster.set(m.clusterId, [...(byCluster.get(m.clusterId) ?? []), m]);
    clusterOf.set(m.listingId, m.clusterId);
  }
  return rows.map((r) => {
    const now = clusterOf.get(r.listingId);
    return {
      ...disputeDto(r),
      agency: { id: r.agencyId, name: names.get(r.agencyId) ?? '' },
      members: (now ? (byCluster.get(now) ?? []) : [])
        .sort((x, y) => x.rank - y.rank)
        .map((m) => ({ listingId: m.listingId, agencyId: m.ownerAgencyId, rank: m.rank, via: m.via })),
    };
  });
}

/**
 * `GET /v1/staff/duplicates/disputes`: every agency's disputes of one status, oldest first, with the listing's cluster
 * now (members, owners, rank). Three statements.
 */
export async function listStaffDuplicateDisputes(
  ctx: StaffCtx,
  raw: StaffDedupeDisputesQuery,
): Promise<StaffDedupeDisputePage> {
  assertStaffCan(ctx, 'staff.dedupe.read');
  const q = StaffDedupeDisputesQuery.parse(raw);
  const rows = await repo.staffDisputesPage(ctx.tx, {
    status: q.status,
    cursor: decodeCursor(q.cursor),
    limit: q.limit,
  });
  const { items, nextCursor } = page(rows, q.limit, (r) => r.id);
  return { items: await staffDtos(ctx, items), nextCursor };
}

/**
 * `POST /v1/staff/duplicates/disputes/:id/resolve`: staff uphold or reject an open dispute with a note; audited
 * (`staff.dedupe.disputeResolved`: outcome and kind, never the note), and an upheld one is applied by the worker
 * (`dedupe.dispute.resolved`, the dispute's agency, in this transaction).
 */
export async function resolveDuplicateDispute(
  ctx: StaffCtx,
  id: string,
  raw: ResolveDedupeDisputeBody,
): Promise<StaffDedupeDisputeDto> {
  assertStaffCan(ctx, 'staff.dedupe.resolve');
  const body = ResolveDedupeDisputeBody.parse(raw);
  const d = await repo.disputeById(ctx.tx, id, true);
  if (!d) throw new AppError('DEDUPE_DISPUTE_NOT_FOUND');
  if (d.status !== 'OPEN') throw new AppError('DEDUPE_DISPUTE_STATE', { status: d.status });
  const resolved = await repo.resolveDispute(ctx.tx, d.id, {
    status: body.outcome,
    userId: ctx.actor.userId,
    note: body.note,
  });
  if (!resolved) throw new AppError('DEDUPE_DISPUTE_STATE');
  await emit(ctx.tx, dedupeEvents.disputeResolved({ disputeId: d.id }), { agencyId: d.agencyId });
  await compliance.auditStaff(
    ctx,
    d.agencyId,
    'staff.dedupe.disputeResolved',
    { type: 'dedupeDispute', id: d.id },
    { outcome: body.outcome, kind: d.kind, listingId: d.listingId },
  );
  const [dto] = await staffDtos(ctx, [resolved]);
  return dto as StaffDedupeDisputeDto;
}
