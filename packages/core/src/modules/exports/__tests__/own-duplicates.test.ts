import { describe, expect, it } from 'vitest';
import { ownDuplicates } from '../selection';

const AG = '00000000-0000-7000-8000-00000000000a';
const OTHER = '00000000-0000-7000-8000-00000000000b';
const members = [
  // the agency's two members of one cluster (confirmed as one)
  { listingId: 'a', clusterId: 'k1', ownerAgencyId: OTHER, rank: 0 },
  { listingId: 'b', clusterId: 'k1', ownerAgencyId: AG, rank: 2 },
  { listingId: 'c', clusterId: 'k1', ownerAgencyId: AG, rank: 1 },
  // one own member beside another agency's canonical: the agency still exports its own listing
  { listingId: 'd', clusterId: 'k2', ownerAgencyId: OTHER, rank: 0 },
  { listingId: 'e', clusterId: 'k2', ownerAgencyId: AG, rank: 1 },
];

describe('portal feeds and duplicate clusters (R2-03c)', () => {
  it('[R2-03] client-facing outputs never show two members of one cluster: portal feed', () => {
    // both selected: the better ranked goes, the other stays out
    expect(ownDuplicates(members, AG)).toEqual(new Set(['b']));
  });

  it('[R2-03c] a member is left out only for a better own member the connection selects (never none of them)', () => {
    // the better ranked one is not in this connection's selection: the other one goes
    expect(ownDuplicates(members, AG, (id) => id !== 'c')).toEqual(new Set());
  });
});
