/**
 * The recluster pass (R2-03b, PLAN §10) — worker functions (PATTERNS §12): no request path; every read and write is
 * the caller's `withSystem` transaction. Incremental: it runs around the listings whose pairs changed (a rescore
 * batch, a listing gone), whose pair a member decided, or whose dispute staff upheld.
 *
 * `reclusterIn(tx, seeds)`, one transaction, under one advisory lock (`repo.lockClusters`: passes never interleave):
 * 1. **Component.** From the seeds, rounds of (a) every member of the clusters the listings are in and (b) the
 *    listings they link to (pairs ≥ 0.9, confirmed pairs), up to `MAX_ROUNDS` rounds and `MAX_COMPONENT` listings
 *    (clusters already holding a listing always come whole). A cut component flags its clusters.
 * 2. **Form** (`clusters.ts`): the live listings (a signature: ACTIVE with a read model), their stored pairs and
 *    decisions among them, ranked by pin, first read model (`search.indexDocsFor`) and quality score
 *    (`properties.listingsQualityInputs`). Gone listings drop out — the canonical is re-picked.
 * 3. **Write** what changed: a new cluster reuses the id of the old one it shares most members with; dissolved clusters
 *    are deleted; the agencies' projections (`dedupe_listing_clusters`) follow; one `dedupe.cluster.changed` per
 *    formed, changed or dissolved cluster, in this transaction.
 * 4. **Review queue** (`dedupe_reviews`): for the seeds and every listing whose cluster changed, each stored pair
 *    (best `REVIEW_PAIRS_PER_LISTING` a side) ≥ 0.7, undecided and not within one cluster gets a pending row for each
 *    agency involved (one when both listings are one agency's); pending rows whose pair is gone, decided or clustered
 *    go. Decided rows stay (the agency's decision).
 */
import type { Tx } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import * as properties from '../properties';
import * as search from '../search';
import { type ClusterNode, type FormedCluster, formClusters, hasConflict } from './clusters';
import { dedupeEvents } from './events';
import * as repo from './repo';
import { AUTO_CLUSTER_SCORE, REVIEW_SCORE } from './scoring';

/** The most listings one pass looks at (a dense block of near-identical flats stays bounded). */
export const MAX_COMPONENT = 400;
/** Expansion rounds from the seeds (clusters hold ≤ `MAX_CLUSTER_MEMBERS`, so a real component is shallow). */
export const MAX_ROUNDS = 6;
/** Stored pairs read per listing and side for the review queue (a listing keeps ≤ 50, others may add a few). */
export const REVIEW_PAIRS_PER_LISTING = 100;

export interface ReclusterResult {
  listings: number;
  clusters: number;
  changed: number;
  dissolved: number;
  truncated: boolean;
}

const pairKey = (x: string, y: string) => (x < y ? `${x}:${y}` : `${y}:${x}`);

interface Component {
  nodes: string[];
  old: Map<string, repo.MemberRow>;
  truncated: boolean;
}

/** Step 1: the seeds' component (whole clusters, linked listings), bounded. */
async function componentOf(tx: Tx, seeds: readonly string[]): Promise<Component> {
  const nodes = new Set(seeds);
  const old = new Map<string, repo.MemberRow>();
  let frontier = [...nodes];
  let truncated = false;
  for (let round = 0; frontier.length > 0; round++) {
    const mates = await repo.clusterMatesOf(tx, frontier);
    const expand = [...frontier];
    for (const m of mates) {
      old.set(m.listingId, m);
      if (!nodes.has(m.listingId)) {
        nodes.add(m.listingId);
        expand.push(m.listingId);
      }
    }
    if (round >= MAX_ROUNDS || nodes.size >= MAX_COMPONENT) {
      truncated = true;
      break;
    }
    frontier = [];
    for (const id of await repo.linkedListingsOf(tx, expand, AUTO_CLUSTER_SCORE)) {
      if (nodes.has(id)) continue;
      if (nodes.size >= MAX_COMPONENT) {
        truncated = true;
        break;
      }
      nodes.add(id);
      frontier.push(id);
    }
  }
  return { nodes: [...nodes], old, truncated };
}

/** Step 2's inputs: the live listings with their rank facts. */
async function nodesOf(tx: Tx, ids: readonly string[]): Promise<ClusterNode[]> {
  const owners = await repo.signatureOwnersOf(tx, ids);
  const live = ids.filter((id) => owners.has(id));
  if (live.length < 2)
    return live.map((id) => ({
      id,
      agencyId: owners.get(id) as string,
      pinnedAt: null,
      listedAt: null,
      quality: null,
    }));
  const { docs } = await search.indexDocsFor(tx, live, { text: false });
  const listed = new Map(docs.map((d) => [d.id, d.publishedAt]));
  const quality = await properties.listingsQualityInputs(tx, live);
  const pins = await repo.pinsOf(tx, live);
  return live.map((id) => ({
    id,
    agencyId: owners.get(id) as string,
    pinnedAt: pins.get(id) ?? null,
    listedAt: listed.get(id) ?? null,
    quality: quality.get(id)?.qualityScore ?? null,
  }));
}

/**
 * Old clusters' ids for the new ones: each new cluster takes the old one it shares the most members with (then the
 * smaller id), each old id once; else a new id.
 */
function assignIds(formed: readonly FormedCluster[], old: Map<string, repo.MemberRow>): string[] {
  const used = new Set<string>();
  return formed.map((c) => {
    const overlap = new Map<string, number>();
    for (const m of c.members) {
      const o = old.get(m.id);
      if (o && !used.has(o.clusterId)) overlap.set(o.clusterId, (overlap.get(o.clusterId) ?? 0) + 1);
    }
    const [best] = [...overlap].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    if (!best) return newId();
    used.add(best[0]);
    return best[0];
  });
}

/** Reclusters around these listings in the caller's (`withSystem`) transaction. Idempotent. */
export async function reclusterIn(tx: Tx, seedIds: readonly string[]): Promise<ReclusterResult> {
  const seeds = [...new Set(seedIds.map((id) => id.toLowerCase()))];
  const empty = { listings: 0, clusters: 0, changed: 0, dissolved: 0, truncated: false };
  if (seeds.length === 0) return empty;
  await repo.lockClusters(tx);
  const { nodes: ids, old, truncated } = await componentOf(tx, seeds);
  const nodes = await nodesOf(tx, ids);
  const liveIds = nodes.map((n) => n.id);
  const [pairs, decisions] = [await repo.pairsAmong(tx, liveIds), await repo.decisionsTouching(tx, liveIds)];
  const formed = formClusters(
    nodes,
    pairs.map((p) => ({ a: p.a, b: p.b, score: p.score, conflict: hasConflict(p.signals) })),
    decisions,
    { truncated },
  );
  const owner = new Map(nodes.map((n) => [n.id, n.agencyId]));

  // step 3: what changed
  const clusterIds = assignIds(formed, old);
  const oldByCluster = new Map<string, repo.MemberRow[]>();
  for (const m of old.values()) oldByCluster.set(m.clusterId, [...(oldByCluster.get(m.clusterId) ?? []), m]);
  const flags = await repo.clusterFlags(tx, [...oldByCluster.keys()]);
  const signature = (ms: readonly { id: string; via: string }[]) => ms.map((m) => `${m.id}/${m.via}`).join(',');
  const writes: repo.ClusterWrite[] = [];
  const events: { clusterId: string; canonicalListingId: string | null; listingIds: string[] }[] = [];
  formed.forEach((c, i) => {
    const id = clusterIds[i] as string;
    const before = (oldByCluster.get(id) ?? []).sort((x, y) => x.rank - y.rank);
    const same =
      signature(before.map((m) => ({ id: m.listingId, via: m.via }))) === signature(c.members) &&
      flags.get(id) === c.flagged;
    if (same) return;
    writes.push({
      id,
      flagged: c.flagged,
      members: c.members.map((m) => ({ id: m.id, ownerAgencyId: owner.get(m.id) as string, via: m.via })),
    });
    events.push({
      clusterId: id,
      canonicalListingId: c.members[0]?.id ?? null,
      listingIds: [...new Set([...before.map((m) => m.listingId), ...c.members.map((m) => m.id)])],
    });
  });
  const kept = new Set(clusterIds);
  const dissolved = [...oldByCluster.keys()].filter((id) => !kept.has(id)).sort();
  for (const id of dissolved) {
    events.push({
      clusterId: id,
      canonicalListingId: null,
      listingIds: (oldByCluster.get(id) ?? []).map((m) => m.listingId),
    });
  }
  await repo.writeClusters(tx, dissolved, writes);

  // the agencies' projections of the listings that were or are in a changed cluster
  const clustered = new Set(writes.flatMap((w) => w.members.map((m) => m.id)));
  const touched = [...new Set(events.flatMap((e) => e.listingIds))];
  await repo.writeListingClusters(
    tx,
    touched.filter((id) => !clustered.has(id)),
    writes.flatMap((w) =>
      w.members.map((m, rank) => ({
        agencyId: m.ownerAgencyId,
        listingId: m.id,
        clusterId: w.id,
        rank,
        via: m.via,
        memberIds: w.members.map((x) => x.id),
      })),
    ),
  );
  if (events.length > 0)
    await emit(
      tx,
      events.map((e) => dedupeEvents.clusterChanged(e)),
    );

  // step 4: the review queue
  const clusterOf = new Map<string, number>();
  formed.forEach((c, i) => {
    for (const m of c.members) clusterOf.set(m.id, i);
  });
  await syncReviews(tx, [...new Set([...seeds, ...touched])], (a, b) => {
    const x = clusterOf.get(a);
    return x !== undefined && x === clusterOf.get(b);
  });
  return {
    listings: nodes.length,
    clusters: formed.length,
    changed: writes.length,
    dissolved: dissolved.length,
    truncated,
  };
}

/** Step 4 (see the file comment). `together`: both listings are in one cluster now. */
async function syncReviews(tx: Tx, ids: readonly string[], together: (a: string, b: string) => boolean) {
  const pairs = await repo.reviewPairsOf(tx, ids, REVIEW_PAIRS_PER_LISTING);
  const decided = new Set(
    (await repo.decisionsTouching(tx, [...new Set(pairs.flatMap((p) => [p.a, p.b]))])).map((d) => pairKey(d.a, d.b)),
  );
  const desired = new Map<string, Parameters<typeof repo.upsertPendingReviews>[1][number]>();
  for (const p of pairs) {
    if (p.score < REVIEW_SCORE || decided.has(pairKey(p.a, p.b)) || together(p.a, p.b)) continue;
    const rows: [string, string, string][] =
      p.agencyA === p.agencyB
        ? [[p.agencyA, p.a, p.b]]
        : [
            [p.agencyA, p.a, p.b],
            [p.agencyB, p.b, p.a],
          ];
    for (const [agencyId, listingId, otherListingId] of rows) {
      desired.set(`${agencyId}:${listingId}:${otherListingId}`, {
        id: newId(),
        agencyId,
        listingId,
        otherListingId,
        score: p.score,
        signals: p.signals,
      });
    }
  }
  const pending = await repo.pendingReviewsTouching(tx, ids);
  await repo.deletePendingReviews(
    tx,
    pending.filter((r) => !desired.has(`${r.agencyId}:${r.listingId}:${r.otherListingId}`)).map((r) => r.id),
  );
  const have = new Map(pending.map((r) => [`${r.agencyId}:${r.listingId}:${r.otherListingId}`, r]));
  await repo.upsertPendingReviews(
    tx,
    [...desired].filter(([k, r]) => have.get(k)?.score !== r.score).map(([, r]) => r),
  );
}

/**
 * `dedupe.applyReview` (worker): a member's decision on a review becomes the pair's decision — `NOT_DUPLICATE` final
 * (it replaces a confirmation), `CONFIRMED` only while the pair is still a stored candidate — and the pair is
 * reclustered. A pending (or missing) review changes nothing.
 */
export async function applyReviewIn(tx: Tx, reviewId: string): Promise<ReclusterResult | null> {
  const r = await repo.reviewById(tx, reviewId);
  if (!r || (r.status !== 'CONFIRMED' && r.status !== 'NOT_DUPLICATE')) return null;
  // Only a decision on the agency's own listing counts (its signature's owner), whatever wrote the row.
  if ((await repo.signatureOwnersOf(tx, [r.listingId])).get(r.listingId) !== r.agencyId) return null;
  const [a, b] = r.listingId < r.otherListingId ? [r.listingId, r.otherListingId] : [r.otherListingId, r.listingId];
  if (r.status === 'CONFIRMED' && !(await repo.pairStored(tx, a, b))) {
    // nothing to confirm any more: the row would claim a grouping that never happens
    await repo.deleteReview(tx, r.id);
    return reclusterIn(tx, [a, b]);
  }
  await repo.upsertDecisions(tx, [{ a, b, decision: r.status, source: 'REVIEW', agencyId: r.agencyId }]);
  return reclusterIn(tx, [a, b]);
}

/**
 * `dedupe.applyDispute` (worker): an upheld dispute applied — `NOT_DUPLICATE`: the listing is decided not a duplicate
 * of every other member of its cluster now (final; it leaves the cluster); `CANONICAL`: the listing is pinned canonical.
 * Only for a listing that is the disputing agency's (its signature's owner). Rejected or open disputes change nothing.
 */
export async function applyDisputeIn(tx: Tx, disputeId: string): Promise<ReclusterResult | null> {
  const d = await repo.disputeById(tx, disputeId);
  if (!d || d.status !== 'UPHELD') return null;
  const owner = (await repo.signatureOwnersOf(tx, [d.listingId])).get(d.listingId);
  if (owner !== d.agencyId) return null;
  if (d.kind === 'CANONICAL') {
    const mates = (await repo.clusterMatesOf(tx, [d.listingId])).map((m) => m.listingId);
    await repo.insertPin(tx, d.listingId, d.id, mates);
  } else {
    const mates = (await repo.clusterMatesOf(tx, [d.listingId])).filter((m) => m.listingId !== d.listingId);
    await repo.upsertDecisions(
      tx,
      mates.map((m) => {
        const [a, b] = d.listingId < m.listingId ? [d.listingId, m.listingId] : [m.listingId, d.listingId];
        return { a, b, decision: 'NOT_DUPLICATE' as const, source: 'DISPUTE' as const, agencyId: null };
      }),
    );
  }
  return reclusterIn(tx, [d.listingId]);
}
