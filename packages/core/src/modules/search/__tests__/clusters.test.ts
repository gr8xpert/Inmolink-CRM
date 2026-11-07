import type { Filter } from '@inmolink/platform/search';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { clusterRuleOf, oneMemberPerCluster } from '../index';
import { clusterShownSql } from '../repo';

const AG = '00000000-0000-7000-8000-00000000000a';
const OTHER = '00000000-0000-7000-8000-00000000000b';
const row = (targetId: string, ownerAgencyId: string, clusterId: string | null, clusterRank: number | null) => ({
  targetId,
  ownerAgencyId,
  clusterId,
  clusterRank,
});

describe('one member per duplicate cluster (R2-03c)', () => {
  it('[R2-03] client-facing outputs never show two members of one cluster: selections keep the agency’s own, then rank', () => {
    const hidden = oneMemberPerCluster(
      [
        row('a', OTHER, 'k1', 0),
        row('b', AG, 'k1', 2),
        row('c', OTHER, 'k1', 1),
        row('d', OTHER, 'k2', 1),
        row('e', OTHER, 'k2', 0),
        row('f', OTHER, null, null),
      ],
      AG,
    );
    expect(hidden).toEqual(new Set(['a', 'c', 'd']));
  });

  it('[R2-03c] per-viewer visible canonical: own member first only on sites that mix own and network listings', () => {
    const req = { requestId: 'r' };
    expect(clusterRuleOf({ ownerAgencyIds: [AG], networkOf: AG, ...req }).own).toEqual([AG]);
    expect(clusterRuleOf({ ownerAgencyIds: [AG], ...req }).own).toBeNull();
    expect(clusterRuleOf({ ownerAgencyIds: null, ...req }).own).toBeNull();
    // the rule's inventory is the site's whole inventory, never the visitor's filters
    const f = JSON.stringify(clusterRuleOf({ ownerAgencyIds: [AG], networkOf: AG, ...req }).filter);
    expect(f).toContain('"visibility"');
    expect(f).not.toContain('priceCents');
  });

  it('[R2-03c] the cluster condition probes the mates by cluster and compiles the inventory against the mate', () => {
    const filter: Filter = { op: 'eq', field: 'ownerAgencyId', value: AG };
    const q = new PgDialect().sqlToQuery(clusterShownSql({ filter, own: null }, 'd'));
    expect(q.sql).toMatch(/^\(d\.cluster_id is null or not exists \(/);
    expect(q.sql).toContain('o.cluster_id = d.cluster_id');
    expect(q.sql).toContain('o.cluster_rank < d.cluster_rank');
    // the inventory condition is unqualified: it names the innermost `from` (the mate `o`)
    expect(q.sql).toContain('and owner_agency_id = $1');
    const own = new PgDialect().sqlToQuery(clusterShownSql({ filter, own: [AG] }, 'd'));
    expect(own.sql).toContain(
      '(o.owner_agency_id = any(array[$1]::uuid[])) > (d.owner_agency_id = any(array[$2]::uuid[]))',
    );
  });
});
