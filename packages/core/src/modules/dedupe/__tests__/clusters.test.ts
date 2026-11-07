import { describe, expect, it } from 'vitest';
import {
  type ClusterDecision,
  type ClusterNode,
  type ClusterPair,
  canonicalOrder,
  formClusters,
  hasConflict,
  MAX_CLUSTER_MEMBERS,
} from '../clusters';

/** The cluster rules (R2-03b) on hand-built components: pure, no database. */

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ClusterNode> = {}): ClusterNode => ({
  id: id(n),
  agencyId: id(900 + n),
  pinnedAt: null,
  listedAt: 1_000 + n,
  quality: 50,
  ...over,
});
const pair = (x: number, y: number, score = 0.95, conflict = false): ClusterPair => ({
  a: id(Math.min(x, y)),
  b: id(Math.max(x, y)),
  score,
  conflict,
});
const decided = (x: number, y: number, decision: ClusterDecision['decision']): ClusterDecision => ({
  a: id(Math.min(x, y)),
  b: id(Math.max(x, y)),
  decision,
});
const ids = (c: { members: { id: string }[] }) => c.members.map((m) => m.id);

describe('dedupe clusters (R2-03b)', () => {
  it('[R2-03b] pairs ≥ 0.9 auto-cluster; review-band pairs (0.7–0.9) do not', () => {
    const out = formClusters([node(1), node(2), node(3)], [pair(1, 2, 0.9), pair(2, 3, 0.89)], []);
    expect(out).toEqual([
      {
        members: [
          { id: id(1), via: 'AUTO' },
          { id: id(2), via: 'AUTO' },
        ],
        flagged: false,
      },
    ]);
    expect(formClusters([node(1), node(2)], [pair(1, 2, 0.85)], [])).toEqual([]);
  });

  it('[R2-03b] no chaining: A ~ B ~ C with A and C unlinked (or conflicting) never form one cluster', () => {
    // A ~ B, B ~ C, no A ~ C pair: C stays out (every auto member links to the canonical)
    const chain = formClusters([node(1), node(2), node(3)], [pair(1, 2), pair(2, 3)], []);
    expect(chain.map(ids)).toEqual([[id(1), id(2)]]);
    // a hard conflict between A and C keeps C out even when C links to A's centre... through a confirmed pair
    const confirmedChain = formClusters(
      [node(1), node(2), node(3)],
      [pair(1, 2), pair(1, 3, 0.75, true)],
      [decided(2, 3, 'CONFIRMED')],
    );
    expect(confirmedChain.map(ids)).toEqual([[id(1), id(2)]]);
    // without the conflict a confirmed pair does bring C in (a person said so)
    const confirmed = formClusters([node(1), node(2), node(3)], [pair(1, 2)], [decided(2, 3, 'CONFIRMED')]);
    expect(confirmed[0]?.members).toEqual([
      { id: id(1), via: 'AUTO' },
      { id: id(2), via: 'AUTO' },
      { id: id(3), via: 'CONFIRMED' },
    ]);
    // a full star: everyone links to the canonical
    const star = formClusters([node(1), node(2), node(3)], [pair(1, 2), pair(1, 3), pair(2, 3)], []);
    expect(star.map(ids)).toEqual([[id(1), id(2), id(3)]]);
  });

  it('[R2-03b] canonical rules are deterministic: pin > earliest listed > higher quality > id', () => {
    const nodes = [
      node(1, { listedAt: 500, quality: 10 }),
      node(2, { listedAt: 100, quality: 10 }),
      node(3, { listedAt: 100, quality: 90 }),
      node(4, { listedAt: null, quality: 99 }),
    ];
    const pairs = [pair(1, 2), pair(1, 3), pair(1, 4), pair(2, 3), pair(2, 4), pair(3, 4)];
    const once = formClusters(nodes, pairs, []);
    expect(once.map(ids)).toEqual([[id(3), id(2), id(1), id(4)]]);
    // input order never matters
    expect(formClusters([...nodes].reverse(), [...pairs].reverse(), [])).toEqual(once);
    // a staff pin wins
    const pinned = formClusters(
      nodes.map((n) => (n.id === id(4) ? { ...n, pinnedAt: 1 } : n)),
      pairs,
      [],
    );
    expect(pinned[0]?.members[0]?.id).toBe(id(4));
    // same facts: the id decides
    expect(canonicalOrder(node(5, { listedAt: 1 }), node(6, { listedAt: 1 }))).toBeLessThan(0);
  });

  it('[R2-03b] a member removed: the canonical is re-picked from the rest', () => {
    const nodes = [node(1), node(2), node(3)];
    const pairs = [pair(1, 2), pair(1, 3), pair(2, 3)];
    expect(formClusters(nodes, pairs, [])[0]?.members[0]?.id).toBe(id(1));
    const without = formClusters(nodes.slice(1), pairs, []);
    expect(without.map(ids)).toEqual([[id(2), id(3)]]);
    // the last pair gone: no cluster
    expect(formClusters(nodes.slice(2), pairs, [])).toEqual([]);
  });

  it('[R2-03b] "not a duplicate" blocks a pair whatever its score, and beats a confirmation', () => {
    expect(formClusters([node(1), node(2)], [pair(1, 2, 0.99)], [decided(1, 2, 'NOT_DUPLICATE')])).toEqual([]);
    // A ~ B ~ C ~ A, B and C decided apart: B joins A, C stays out
    const out = formClusters(
      [node(1), node(2), node(3)],
      [pair(1, 2), pair(1, 3), pair(2, 3)],
      [decided(2, 3, 'NOT_DUPLICATE')],
    );
    expect(out.map(ids)).toEqual([[id(1), id(2)]]);
    expect(hasConflict({ beds: 0, area: 1, price: 1 })).toBe(true);
    expect(hasConflict({ beds: 1, area: null, price: 0.5 })).toBe(false);
  });

  it('[R2-03b] a cluster stops at MAX_CLUSTER_MEMBERS and is flagged; a cut component flags its clusters', () => {
    const nodes = Array.from({ length: MAX_CLUSTER_MEMBERS + 3 }, (_, i) => node(i + 1));
    const pairs = nodes.slice(1).map((_, i) => pair(1, i + 2));
    const [big, ...rest] = formClusters(nodes, pairs, []);
    expect(big?.members).toHaveLength(MAX_CLUSTER_MEMBERS);
    expect(big?.flagged).toBe(true);
    expect(rest).toEqual([]);
    expect(formClusters([node(1), node(2)], [pair(1, 2)], [], { truncated: true })[0]?.flagged).toBe(true);
  });
});
