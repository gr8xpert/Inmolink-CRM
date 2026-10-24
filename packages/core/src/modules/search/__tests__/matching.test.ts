import type { Filter, SearchEngine, SearchQuery } from '@inmolink/platform/search';
import { describe, expect, it } from 'vitest';
import { listingsIndex } from '../index-doc';
import { matchListingOwners } from '../matching';

/**
 * Owner matching in rounds (S11-05): the engine counts at most `maxValuesPerFacet` (200) owners per query, so a buyer
 * request matching more agencies is read in rounds that leave out the owners found. A fake engine applies the owner
 * filters (`in` / `not in` on `ownerAgencyId`; every other filter matches) and caps its facet like Meilisearch.
 */

const CAP = listingsIndex('t').maxValuesPerFacet;
const SELF = 'self-agency';

interface Doc {
  id: string;
  ownerAgencyId: string;
  publishedAt: number;
}

const touchesOwner = (f: Filter): boolean =>
  f.op === 'and' || f.op === 'or'
    ? f.filters.some(touchesOwner)
    : f.op === 'not'
      ? touchesOwner(f.filter)
      : 'field' in f && f.field === 'ownerAgencyId';

function owners(f: Filter | undefined, doc: Doc): boolean {
  if (!f) return true;
  switch (f.op) {
    case 'and':
      return f.filters.every((x) => owners(x, doc));
    case 'or':
      return f.filters.some((x) => owners(x, doc));
    case 'not':
      // only owner filters are applied: another field's negation matches like the field itself
      return touchesOwner(f.filter) ? !owners(f.filter, doc) : true;
    case 'eq':
      return f.field === 'ownerAgencyId' ? doc.ownerAgencyId === f.value : true;
    case 'in':
      return f.field === 'ownerAgencyId' ? f.values.includes(doc.ownerAgencyId) : true;
    default:
      return true;
  }
}

function fakeEngine(docs: Doc[]): SearchEngine & { calls: number } {
  const engine = {
    calls: 0,
    async search(_def: unknown, q: SearchQuery) {
      engine.calls += 1;
      const hits = docs.filter((d) => owners(q.filter, d)).sort((a, b) => b.publishedAt - a.publishedAt);
      const counts: Record<string, number> = {};
      for (const d of hits) counts[d.ownerAgencyId] = (counts[d.ownerAgencyId] ?? 0) + 1;
      const capped = Object.fromEntries(
        Object.entries(counts)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .slice(0, CAP),
      );
      return {
        ids: hits.slice(0, q.limit).map((d) => d.id),
        total: hits.length,
        facets: q.facets ? { ownerAgencyId: capped } : {},
        facetStats: {},
        tookMs: 1,
      };
    },
    async fetch(_uid: string, ids: readonly string[]) {
      const byId = new Map(docs.map((d) => [d.id, d]));
      return ids.flatMap((id) => {
        const d = byId.get(id);
        return d ? [{ id: d.id, ownerAgencyId: d.ownerAgencyId }] : [];
      });
    },
  };
  return engine as unknown as SearchEngine & { calls: number };
}

/** `agencies` owners with 1–3 matching listings each, and the asker's own. */
function docsOf(agencies: number): Doc[] {
  const docs: Doc[] = [];
  let t = 0;
  for (let a = 0; a < agencies; a++) {
    for (let i = 0; i < 1 + (a % 3); i++) docs.push({ id: `l-${a}-${i}`, ownerAgencyId: `a-${a}`, publishedAt: t++ });
  }
  docs.push({ id: 'own', ownerAgencyId: SELF, publishedAt: t++ });
  return docs;
}

describe('matchListingOwners', () => {
  it('[S11-05] a buyer request matching listings of more than 200 agencies finds every owner, in rounds', async () => {
    const engine = fakeEngine(docsOf(450));
    const { owners: found, truncated } = await matchListingOwners({}, { excludeAgencyId: SELF, perAgency: 10, engine });
    expect(truncated).toBe(false);
    expect(found).toHaveLength(450);
    expect(found.find((o) => o.agencyId === SELF)).toBeUndefined();
    const a5 = found.find((o) => o.agencyId === 'a-5');
    expect(a5).toMatchObject({ count: 3, listingIds: ['l-5-2', 'l-5-1', 'l-5-0'] });
    expect(found.every((o) => o.listingIds.length === o.count)).toBe(true);
    // three rounds (200 + 200 + 50), each a facet query and a sample query; the last facet is below the cap
    expect(engine.calls).toBe(6);
  });

  it('[S11-05] fewer owners than the cap take one round', async () => {
    const engine = fakeEngine(docsOf(30));
    const { owners: found } = await matchListingOwners({}, { excludeAgencyId: SELF, perAgency: 2, engine });
    expect(found).toHaveLength(30);
    expect(found.every((o) => o.listingIds.length === Math.min(2, o.count))).toBe(true);
    expect(engine.calls).toBe(2);
  });

  it('[S11-05] beyond the round limit the rest is left out and reported as truncated', async () => {
    const engine = fakeEngine(docsOf(450));
    const { owners: found, truncated } = await matchListingOwners(
      {},
      { excludeAgencyId: SELF, perAgency: 10, engine, maxRounds: 2 },
    );
    expect(truncated).toBe(true);
    expect(found).toHaveLength(400);
  });

  it('[S11-05] no match: no owners, one query', async () => {
    const engine = fakeEngine([{ id: 'own', ownerAgencyId: SELF, publishedAt: 1 }]);
    expect(await matchListingOwners({}, { excludeAgencyId: SELF, perAgency: 10, engine })).toEqual({
      owners: [],
      truncated: false,
    });
    expect(engine.calls).toBe(1);
  });
});
