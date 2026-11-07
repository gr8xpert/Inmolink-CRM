/**
 * Duplicate clusters (R2-03b, PLAN §10) — pure: which listings of a component form clusters, and in which order (the
 * canonical first). The recluster pass (`recluster.ts`) feeds it a component's live listings, their stored pairs and
 * decided pairs; nothing here reads the database.
 *
 * **Links.** An *auto* link is a stored pair scoring ≥ `AUTO_CLUSTER_SCORE` (0.9) that is not decided "not a
 * duplicate". A *confirmed* link is a pair a member confirmed in the review queue. A *conflict* is a pair decided "not a
 * duplicate", or a stored pair with a hard conflict (beds two apart, m² or price 20 % off: a 0 signal).
 *
 * **No chaining (star rule).** Listings are taken in canonical order. Each one not yet placed is a centre: it takes
 * every unplaced listing it has an auto link with (canonical order), then — repeatedly — every unplaced listing with a
 * confirmed link to a member (a person said so); a listing joins only if it conflicts with no member, and a cluster
 * holds at most `MAX_CLUSTER_MEMBERS`. So with A ~ B ~ C (auto), C joins A's cluster only if C links to A itself: two
 * listings that are each like a third but not like each other are never merged by score alone. A centre that takes
 * nobody stays unclustered (and may join a later centre's cluster: links are symmetric). A cluster at the cap, or of a
 * component the pass had to cut (`truncated`), is `flagged` for staff.
 *
 * **Canonical order** (PLAN §10: exclusive mandate > earliest listing > higher quality score): a listing staff pinned
 * (an upheld `CANONICAL` dispute; the earlier pin first), then the earliest listed (first read model; unknown last),
 * then the higher quality score (unknown lowest), then the id. Exclusive mandates are not recorded yet (no mandate
 * field): when they are, they rank right after a pin. Deterministic: the same inputs give the same clusters and ranks.
 */
import { AUTO_CLUSTER_SCORE, type PairSignals } from './scoring';

/** The most listings one cluster holds (one property listed by many agencies); a full cluster is flagged. */
export const MAX_CLUSTER_MEMBERS = 12;

export interface ClusterNode {
  id: string;
  agencyId: string;
  /** Epoch ms of a staff pin, else null. */
  pinnedAt: number | null;
  /** Epoch seconds of the first read model ("earliest listing"), else null. */
  listedAt: number | null;
  /** 0–100, else null. */
  quality: number | null;
}

export interface ClusterPair {
  a: string;
  b: string;
  score: number;
  /** A hard conflict between the two (never in one cluster). */
  conflict: boolean;
}

export interface ClusterDecision {
  a: string;
  b: string;
  decision: 'CONFIRMED' | 'NOT_DUPLICATE';
}

export type MemberVia = 'AUTO' | 'CONFIRMED';

export interface FormedCluster {
  /** Canonical order: `members[0]` is the canonical listing. */
  members: { id: string; via: MemberVia }[];
  flagged: boolean;
}

/** A stored pair's hard conflict: one of the facts that rule a duplicate out (`scoring.ts` caps these at 0.85). */
export function hasConflict(s: Pick<PairSignals, 'beds' | 'area' | 'price'>): boolean {
  return s.beds === 0 || s.area === 0 || s.price === 0;
}

/** Canonical order (see the file comment): negative when `x` ranks before `y`. */
export function canonicalOrder(x: ClusterNode, y: ClusterNode): number {
  const pin = (n: ClusterNode) => n.pinnedAt ?? Number.POSITIVE_INFINITY;
  if (pin(x) !== pin(y)) return pin(x) - pin(y);
  const listed = (n: ClusterNode) => n.listedAt ?? Number.POSITIVE_INFINITY;
  if (listed(x) !== listed(y)) return listed(x) - listed(y);
  const q = (n: ClusterNode) => n.quality ?? -1;
  if (q(x) !== q(y)) return q(y) - q(x);
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

const key = (x: string, y: string) => (x < y ? `${x}:${y}` : `${y}:${x}`);

/** The clusters of one component (see the file comment). Nodes, pairs and decisions outside `nodes` are ignored. */
export function formClusters(
  nodes: readonly ClusterNode[],
  pairs: readonly ClusterPair[],
  decisions: readonly ClusterDecision[],
  options: { truncated?: boolean; maxMembers?: number } = {},
): FormedCluster[] {
  const max = options.maxMembers ?? MAX_CLUSTER_MEMBERS;
  const ids = new Set(nodes.map((n) => n.id));
  const blocked = new Set<string>();
  const confirmed = new Set<string>();
  for (const d of decisions) {
    if (!ids.has(d.a) || !ids.has(d.b)) continue;
    (d.decision === 'NOT_DUPLICATE' ? blocked : confirmed).add(key(d.a, d.b));
  }
  const conflict = new Set(blocked);
  const auto = new Set<string>();
  for (const p of pairs) {
    if (!ids.has(p.a) || !ids.has(p.b)) continue;
    const k = key(p.a, p.b);
    if (p.conflict) conflict.add(k);
    else if (p.score >= AUTO_CLUSTER_SCORE && !blocked.has(k)) auto.add(k);
  }
  for (const k of blocked) confirmed.delete(k);
  for (const k of conflict) confirmed.delete(k);

  const order = [...nodes].sort(canonicalOrder);
  const placed = new Set<string>();
  const out: FormedCluster[] = [];
  for (const centre of order) {
    if (placed.has(centre.id)) continue;
    const members: { id: string; via: MemberVia }[] = [{ id: centre.id, via: 'AUTO' }];
    const fits = (id: string) =>
      !placed.has(id) &&
      members.length < max &&
      !members.some((m) => m.id === id) &&
      members.every((m) => !conflict.has(key(m.id, id)));
    for (const n of order) {
      if (n.id !== centre.id && auto.has(key(centre.id, n.id)) && fits(n.id)) members.push({ id: n.id, via: 'AUTO' });
    }
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of order) {
        if (fits(n.id) && members.some((m) => confirmed.has(key(m.id, n.id)))) {
          members.push({ id: n.id, via: 'CONFIRMED' });
          grew = true;
        }
      }
    }
    if (members.length < 2) continue;
    // the centre joined through its links: confirmed only when it has no auto link to a member
    const centreVia: MemberVia = members.some((m) => m.via === 'AUTO' && m.id !== centre.id) ? 'AUTO' : 'CONFIRMED';
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const sorted = members
      .map((m) => (m.id === centre.id ? { id: m.id, via: centreVia } : m))
      .sort((x, y) => canonicalOrder(byId.get(x.id) as ClusterNode, byId.get(y.id) as ClusterNode));
    for (const m of sorted) placed.add(m.id);
    out.push({ members: sorted, flagged: sorted.length >= max || options.truncated === true });
  }
  return out;
}
