import { describe, expect, it } from 'vitest';
import { clustersOf } from '../delivery';

/** R2-03c: AUTO_SEND delivery treats a duplicate cluster as one property (pure half of `deliverProfile`). */
const AG = '00000000-0000-7000-8000-00000000000a';
const OTHER = '00000000-0000-7000-8000-00000000000b';
const members = [
  { listingId: 'x0', clusterId: 'k1', ownerAgencyId: OTHER, rank: 0 },
  { listingId: 'x1', clusterId: 'k1', ownerAgencyId: AG, rank: 1 },
  { listingId: 'x2', clusterId: 'k1', ownerAgencyId: OTHER, rank: 2 },
  { listingId: 'y0', clusterId: 'k2', ownerAgencyId: OTHER, rank: 0 },
  { listingId: 'y1', clusterId: 'k2', ownerAgencyId: OTHER, rank: 1 },
];

describe('matching delivery and duplicate clusters (R2-03c)', () => {
  it('[R2-03] client-facing outputs never show two members of one cluster: matching delivery', () => {
    const { oneOf } = clustersOf(members, AG);
    const rows = ['x2', 'y1', 'solo', 'x0', 'y0', 'x1'].map((listingId, i) => ({ id: `m${i}`, listingId }));
    const sent = oneOf(rows).map((r) => r.listingId);
    // one per cluster: the agency's own member first (x1), else the canonical rank (y0); unclustered ones stay
    expect(sent).toEqual(['x1', 'y0', 'solo']);
    expect(new Set(sent).size).toBe(sent.length);
  });

  it('[R2-03c] a cluster counts as already sent across its members', () => {
    const { mates } = clustersOf(members, AG);
    expect(new Set(mates('x2'))).toEqual(new Set(['x0', 'x1', 'x2']));
    expect(mates('solo')).toEqual(['solo']);
    const sentBefore = new Set(['x0']);
    const had = (id: string) => mates(id).some((m) => sentBefore.has(m));
    expect(['x1', 'x2', 'y1', 'solo'].filter((id) => !had(id))).toEqual(['y1', 'solo']);
  });
});
