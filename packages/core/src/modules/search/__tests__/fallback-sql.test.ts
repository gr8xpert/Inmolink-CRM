import { PUBLIC_SEARCH_FACETS, PUBLIC_SEARCH_SORTS, PublicListingSearch } from '@inmolink/contracts';
import { SearchError } from '@inmolink/platform/search';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { listingsIndex } from '../index-doc';
import { fallbackCondition, fallbackSearchSql } from '../repo';
import { developmentRefMatch, publicSearchFilter, refFilter } from '../website';

/** The fallback's filter compiler (S5-04): the engine's semantics in SQL, values always parameters. */

const render = (s: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(s);
const ID = '0195f0a5-0000-7000-8000-000000000001';

describe('fallback filter → SQL', () => {
  it('[S5-04] array fields: eq holds the value (@>), in shares one (&&); scalars use = / = any', () => {
    const q = render(
      fallbackCondition({
        op: 'and',
        filters: [
          { op: 'eq', field: 'locationIds', value: ID },
          { op: 'in', field: 'featureIds', values: [ID, ID] },
          { op: 'in', field: 'status', values: ['ACTIVE', 'AVAILABLE'] },
          { op: 'eq', field: 'ownerAgencyId', value: ID },
        ],
      }),
    );
    expect(q.sql).toBe(
      '(location_ids @> array[$1]::uuid[] and feature_ids && array[$2, $3]::uuid[] and status = any(array[$4, $5]::text[]) and owner_agency_id = $6)',
    );
    expect(q.params).toEqual([ID, ID, ID, 'ACTIVE', 'AVAILABLE', ID]);
  });

  it('[S5-04] a range never matches a null, with either bound alone; not treats unknown as false', () => {
    expect(render(fallbackCondition({ op: 'range', field: 'beds', lte: 3 })).sql).toBe(
      '(beds is not null and beds <= $1)',
    );
    expect(render(fallbackCondition({ op: 'not', filter: { op: 'range', field: 'priceCents', gte: 5 } })).sql).toBe(
      '(not coalesce((price_cents is not null and price_cents >= $1), false))',
    );
  });

  it('[S5-04] visibility is constant PUBLIC; unknown fields are refused, as are bad values', () => {
    expect(render(fallbackCondition({ op: 'eq', field: 'visibility', value: 'PUBLIC' })).sql).toBe('true');
    expect(render(fallbackCondition({ op: 'in', field: 'visibility', values: ['SHARED'] })).sql).toBe('false');
    expect(() => fallbackCondition({ op: 'eq', field: 'allowedAgencyIds', value: 'x' })).toThrow(SearchError);
    expect(() => fallbackCondition({ op: 'eq', field: 'id; drop table x', value: 1 })).toThrow(SearchError);
    expect(() => fallbackCondition({ op: 'range', field: 'status', gte: 1 })).toThrow(SearchError);
    expect(() => fallbackCondition({ op: 'eq', field: 'beds', value: 'x' })).toThrow(SearchError);
    expect(() => fallbackCondition({ op: 'in', field: 'status', values: [] })).toThrow(SearchError);
    expect(() => fallbackCondition({ op: 'and', filters: [] })).toThrow(SearchError);
  });

  it('[S7-02] references compare case-insensitively (the lower(ref) index), values as parameters', () => {
    const eq = render(fallbackCondition({ op: 'eq', field: 'ref', value: 'AB12' }));
    expect(eq.sql).toBe('lower(ref) = lower($1)');
    expect(eq.params).toEqual(['AB12']);
    expect(render(fallbackCondition({ op: 'in', field: 'ref', values: ['A', 'B'] })).sql).toBe(
      'lower(ref) in (lower($1), lower($2))',
    );
  });

  it('[S7-02] white-label references: own documents by their reference, network ones by `<prefix>-<public code>` only', () => {
    const own = '01900000-0000-7000-8000-0000000000aa';
    const site = { ownerAgencyIds: [own], networkOf: own, networkRefPrefix: 'CH' };
    expect(refFilter(site, 'AB12')).toEqual({
      op: 'and',
      filters: [
        { op: 'in', field: 'ownerAgencyId', values: [own] },
        { op: 'eq', field: 'ref', value: 'AB12' },
      ],
    });
    expect(refFilter(site, 'ch-AB12')).toEqual({
      op: 'or',
      filters: [
        {
          op: 'and',
          filters: [
            { op: 'in', field: 'ownerAgencyId', values: [own] },
            { op: 'eq', field: 'ref', value: 'ch-AB12' },
          ],
        },
        {
          op: 'and',
          filters: [
            { op: 'not', filter: { op: 'in', field: 'ownerAgencyId', values: [own] } },
            { op: 'eq', field: 'publicCode', value: 'AB12' },
          ],
        },
      ],
    });
    // A network-only site: only the prefixed form can match; other text matches no reference at all.
    const networkOnly = { ownerAgencyIds: [], networkOf: own, networkRefPrefix: 'CH' };
    expect(refFilter(networkOnly, 'AB12')).toBeNull();
    expect(refFilter(networkOnly, 'CH-AB12')).toEqual({
      op: 'and',
      filters: [{ op: 'eq', field: 'publicCode', value: 'AB12' }],
    });
    expect(refFilter({ ...networkOnly, networkRefPrefix: undefined }, 'CH-AB12')).toBeNull();
    // A site without network documents matches references as they are.
    expect(refFilter({ ownerAgencyIds: [own] }, 'AB12')).toEqual({ op: 'eq', field: 'ref', value: 'AB12' });
  });

  it('[S7-01] network fields: share scope, preferred agencies (contains) and the freshness flag', () => {
    const id = '01900000-0000-7000-8000-000000000001';
    expect(render(fallbackCondition({ op: 'eq', field: 'shareScope', value: 'ALL' })).sql).toContain('share_scope =');
    expect(render(fallbackCondition({ op: 'eq', field: 'preferredAgencyIds', value: id })).sql).toContain(
      'preferred_agency_ids @>',
    );
    expect(
      render(fallbackCondition({ op: 'not', filter: { op: 'eq', field: 'networkHidden', value: true } })).sql,
    ).toContain('network_hidden =');
  });

  it('[S7-F4] a minimum commission narrows the network branch only; the fallback compares the hidden column and skips unknown ones', () => {
    const own = '01900000-0000-7000-8000-0000000000aa';
    const q = PublicListingSearch.parse({ locale: 'en' });
    const site = { ownerAgencyIds: [own], networkOf: own, restrict: { minCommissionBp: 300 } };
    const filter = publicSearchFilter(site, q);
    const text = JSON.stringify(filter);
    expect(text).toContain('{"op":"range","field":"commissionBp","gte":300}');
    // Inside the network branch (with the sharing rule), beside the own-agency branch.
    const whose = (filter as { filters: { op: string; filters?: unknown[] }[] }).filters[2];
    expect(whose?.op).toBe('or');
    const [ownBranch, networkBranch] = (whose as { filters: unknown[] }).filters as [
      { op: string },
      { op: string; filters: unknown[] },
    ];
    expect(JSON.stringify(ownBranch)).not.toContain('commissionBp');
    expect(JSON.stringify(networkBranch)).toContain('commissionBp');
    const rendered = render(fallbackCondition({ op: 'range', field: 'commissionBp', gte: 300 }));
    expect(rendered.sql).toBe('public.search_commission_at_least(target_id, $1::int)');
    expect(rendered.sql).not.toContain('commission_bp');
    // Only a minimum can be asked: the value is not comparable any other way.
    expect(() => fallbackCondition({ op: 'range', field: 'commissionBp', lte: 900 })).toThrow(SearchError);
    expect(() => fallbackCondition({ op: 'eq', field: 'commissionBp', value: 300 })).toThrow(SearchError);
    // No minimum: no commission condition anywhere.
    expect(JSON.stringify(publicSearchFilter({ ownerAgencyIds: [own], networkOf: own }, q))).not.toContain(
      'commission',
    );
  });

  it('[S7-F4] the commission is never a facet or a sort of the public search', () => {
    expect(PUBLIC_SEARCH_FACETS.join()).not.toMatch(/commission/i);
    expect(PUBLIC_SEARCH_SORTS.join()).not.toMatch(/commission/i);
    expect(Object.keys(PublicListingSearch.shape).join()).not.toMatch(/commission/i);
    expect(listingsIndex().sortable.join()).not.toMatch(/commission/i);
    expect(listingsIndex().displayed).toEqual(['id']);
  });

  it('[S5-04] geo: a box (wrapping across the antimeridian) and a radius in meters', () => {
    expect(render(fallbackCondition({ op: 'geoBox', north: 37, south: 36, west: -5, east: -4 })).sql).toBe(
      '(lat between $1 and $2 and lng between $3 and $4)',
    );
    expect(render(fallbackCondition({ op: 'geoBox', north: 1, south: -1, west: 179, east: -179 })).sql).toBe(
      '(lat between $1 and $2 and (lng >= $3 or lng <= $4))',
    );
    const radius = render(fallbackCondition({ op: 'geoRadius', lat: 36.5, lng: -5, meters: 1_000 }));
    expect(radius.sql).toContain('12742000 * asin(');
    // the bounding box first: 1 km is ~0.009° of latitude
    expect(radius.params[0]).toBeCloseTo(36.491, 3);
    expect(radius.params.at(-1)).toBe(1_000);
  });

  it('[S5-04] keyset pages: a nullable sort walks values then nulls; a never-null sort has no null phase', () => {
    const base = { filter: { op: 'eq', field: 'status', value: 'ACTIVE' } as const, limit: 2, countCap: 1_000 };
    const first = render(fallbackSearchSql({ ...base, sort: { field: 'priceCents', dir: 'desc' } })).sql;
    expect(first).toContain('price_cents is not null');
    expect(first).toContain('price_cents is null');
    const nulls = render(
      fallbackSearchSql({
        ...base,
        sort: { field: 'priceCents', dir: 'desc' },
        after: { phase: 1, value: null, id: ID },
      }),
    ).sql;
    expect(nulls).not.toContain('price_cents is not null');
    expect(nulls).toContain('target_id < $');
    expect(render(fallbackSearchSql({ ...base, sort: { field: 'publishedAt', dir: 'desc' } })).sql).not.toContain(
      'published_at is null',
    );
    expect(() =>
      fallbackSearchSql({
        ...base,
        sort: { field: 'publishedAt', dir: 'desc' },
        after: { phase: 1, value: null, id: ID },
      }),
    ).toThrow(SearchError);
    expect(() => fallbackSearchSql({ ...base, sort: { field: 'ref', dir: 'asc' } })).toThrow(SearchError);
    // S6-F2: no page of the fallback is an SQL OFFSET (an engine cursor restarts at the first page instead).
    expect(first).not.toMatch(/\boffset\b/i);
    expect(nulls).not.toMatch(/\boffset\b/i);
  });

  it('[S6-F2] gt (keyset walks of the engine) is refused by the fallback', () => {
    expect(() => fallbackCondition({ op: 'gt', field: 'publishedAt', value: 1 })).toThrow(SearchError);
  });
});

describe('development references (S7-F6)', () => {
  const own = '01900000-0000-7000-8000-0000000000aa';
  const network = { ownerAgencyIds: [own], networkOf: own, networkRefPrefix: 'CH' };

  it('[S7-F6] own developments by their own reference, network ones by `<prefix>-<code>` only (prefix in any case)', () => {
    expect(developmentRefMatch(network, 'ch-ab12cd34')).toEqual({ ownRef: 'ch-ab12cd34', code: 'AB12CD34' });
    expect(developmentRefMatch(network, 'PROMO-7')).toEqual({ ownRef: 'PROMO-7', code: null });
    // Not a code after the prefix: no network development can match.
    expect(developmentRefMatch(network, 'CH-AB12')).toEqual({ ownRef: 'CH-AB12', code: null });
    // An own-only site never matches the network form; a network-only site never an own reference.
    expect(developmentRefMatch({ ownerAgencyIds: [own] }, 'CH-AB12CD34')).toEqual({
      ownRef: 'CH-AB12CD34',
      code: null,
    });
    expect(developmentRefMatch({ ...network, ownerAgencyIds: [] }, 'CH-AB12CD34')).toEqual({
      ownRef: null,
      code: 'AB12CD34',
    });
    expect(developmentRefMatch({ ...network, networkRefPrefix: 'ab1' }, 'AB1-AB12CD34').code).toBe('AB12CD34');
  });

  it('[S7-F6] a raw development id matches the site’s own developments only; a reference compiles to its two branches', () => {
    const q = PublicListingSearch.parse({ locale: 'en', developmentId: ID, developmentRef: 'CH-AB12CD34' });
    const sqlText = render(fallbackCondition(publicSearchFilter(network, q))).sql;
    expect(sqlText).toContain('development_id = $');
    expect(sqlText).toContain('listing_search_developments');
    expect(sqlText).toContain('listing_public_codes');
    const filter = JSON.stringify(publicSearchFilter(network, q));
    expect(filter).toContain('"developmentOwnRef"');
    expect(filter).toContain('"developmentCode"');
    // A network-only site has no own developments: a raw id matches nothing.
    const none = JSON.stringify(publicSearchFilter({ ...network, ownerAgencyIds: [] }, q));
    expect(none).toContain('ffffffff-ffff-ffff-ffff-ffffffffffff');
  });
});
