import { PUBLIC_SEARCH_FACETS, PUBLIC_SEARCH_SORTS, PublicListingSearch } from '@inmolink/contracts';
import { type Filter, SearchError } from '@inmolink/platform/search';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { listingsIndex } from '../index-doc';
import { fallbackCondition, fallbackSearchSql, requiresValue } from '../repo';
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
      '(location_ids @> array[$1]::uuid[] and feature_ids && array[$2, $3]::uuid[] and (status = any(array[$4, $5]::text[])) is true and owner_agency_id = $6)',
    );
    expect(q.params).toEqual([ID, ID, ID, 'ACTIVE', 'AVAILABLE', ID]);
  });

  it('[S7-F11] a status set with ACTIVE is a filter (never an index condition); one without stays indexable', () => {
    expect(render(fallbackCondition({ op: 'in', field: 'status', values: ['ACTIVE', 'AVAILABLE'] })).sql).toBe(
      '(status = any(array[$1, $2]::text[])) is true',
    );
    expect(render(fallbackCondition({ op: 'in', field: 'status', values: ['RESERVED'] })).sql).toBe(
      'status = any(array[$1]::text[])',
    );
  });

  it('[S5-04] a range never matches a null, with either bound alone; not treats unknown as false', () => {
    expect(render(fallbackCondition({ op: 'range', field: 'beds', lte: 3 })).sql).toBe(
      '(beds is not null and beds <= $1)',
    );
    expect(render(fallbackCondition({ op: 'not', filter: { op: 'range', field: 'priceCents', gte: 5 } })).sql).toBe(
      '(not coalesce((price_cents is not null and price_cents >= $1), false))',
    );
  });

  it('[S7-F9] the network rule negations are planner-estimable forms with the same meaning', () => {
    const not = (filter: Parameters<typeof fallbackCondition>[0]) =>
      render(fallbackCondition({ op: 'not', filter })).sql;
    // Never-null columns: a plain inequality (`not coalesce(x = v, false)` is `x <> v` when x is never null).
    expect(not({ op: 'eq', field: 'ownerAgencyId', value: ID })).toBe('owner_agency_id <> $1');
    expect(not({ op: 'in', field: 'ownerAgencyId', values: [ID, ID] })).toBe(
      'owner_agency_id <> all(array[$1, $2]::uuid[])',
    );
    // A nullable boolean: `is not true` matches false and null, like `not coalesce(x = true, false)`.
    expect(not({ op: 'eq', field: 'networkHidden', value: true })).toBe('network_hidden is not true');
    expect(not({ op: 'eq', field: 'networkHidden', value: false })).toBe('network_hidden is not false');
    // Nullable scalars, arrays and case-insensitive text keep the general form.
    expect(not({ op: 'eq', field: 'developmentId', value: ID })).toMatch(/^\(not coalesce\(/);
    expect(not({ op: 'eq', field: 'locationIds', value: ID })).toMatch(/^\(not coalesce\(/);
    expect(not({ op: 'eq', field: 'ref', value: 'A1' })).toMatch(/^\(not coalesce\(/);
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
    ).toBe('network_hidden is not true'); // S7-F9: an estimable form, null not hidden
  });

  it('[S14-F10] kind compares the enum column (estimable), never `kind::text`; a value that is no kind matches none', () => {
    const eq = render(fallbackCondition({ op: 'eq', field: 'kind', value: 'LISTING' }));
    expect(eq.sql).toBe('kind = any(array[$1]::read_model_kind[])');
    expect(eq.params).toEqual(['LISTING']);
    expect(render(fallbackCondition({ op: 'in', field: 'kind', values: ['UNIT', 'LISTING', 'UNIT'] })).params).toEqual([
      'UNIT',
      'LISTING',
    ]);
    expect(render(fallbackCondition({ op: 'eq', field: 'kind', value: 'NOPE' })).sql).toBe('false');
    expect(render(fallbackCondition({ op: 'not', filter: { op: 'eq', field: 'kind', value: 'UNIT' } })).sql).toBe(
      'kind <> all(array[$1]::read_model_kind[])',
    );
    expect(render(fallbackCondition({ op: 'not', filter: { op: 'in', field: 'kind', values: ['X'] } })).sql).toBe(
      'true',
    );
    const network = render(
      fallbackCondition(
        publicSearchFilter({ ownerAgencyIds: [ID], networkOf: ID }, PublicListingSearch.parse({ locale: 'en' })),
      ),
    ).sql;
    expect(network).not.toContain('kind::text');
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
    // S7-F10: a per-row probe of the generated view (ids of the targets paying at least the transaction's minimum),
    // checked against this filter's own minimum; never the value.
    expect(rendered.sql.replace(/\s+/g, ' ')).toBe(
      'exists (select 1 from public.search_commission_floor cf where cf.floor_target_id = target_id and cf.floor_bp = $1::int offset 0)',
    );
    expect(rendered.params).toEqual([300]);
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

  it('[S7-F11] with a location, the capped match set filters ranges (never a range bitmap); the index walks keep them', () => {
    const band: Filter = { op: 'range', field: 'priceCents', gte: 1, lte: 2 };
    const base = { limit: 2, countCap: 1_000, sort: { field: 'priceCents', dir: 'asc' } } as const;
    const city = { op: 'eq', field: 'locationIds', value: ID } as const;
    const s = render(fallbackSearchSql({ ...base, filter: { op: 'and', filters: [city, band] } })).sql;
    const [match, rest] = s.split(/\),\s+c as materialized/) as [string, string];
    expect(match).toContain('((price_cents is not null and price_cents >= $2 and price_cents <= $3) is true)');
    expect(rest).toMatch(
      /where \(location_ids @> array\[\$\d+\]::uuid\[\] and \(price_cents is not null and price_cents >= /,
    );
    expect(rest).not.toContain('is true');
    // Without a location the band drives the match set through its index (S7-F9's network band shapes).
    const bandOnly = render(fallbackSearchSql({ ...base, filter: band })).sql;
    expect(bandOnly).not.toContain('is true');
  });

  it('[S7-F9] a filter that bounds the sort column has no null phase to scan (a price band sorted by price)', () => {
    const band: Filter = { op: 'range', field: 'priceCents', gte: 1, lte: 2 };
    const network: Filter = {
      op: 'or',
      filters: [
        { op: 'eq', field: 'shareScope', value: 'ALL' },
        { op: 'eq', field: 'preferredAgencyIds', value: ID },
      ],
    };
    const base = { limit: 2, countCap: 1_000, sort: { field: 'priceCents', dir: 'asc' } } as const;
    const bounded = render(fallbackSearchSql({ ...base, filter: { op: 'and', filters: [network, band] } })).sql;
    expect(bounded).not.toContain('price_cents is null');
    expect(bounded).toMatch(/1 as phase from "listing_search_docs"\s+where false/);
    // A phase-1 cursor on such a filter (forged: none is ever issued) ends the results instead of failing.
    const after = render(fallbackSearchSql({ ...base, filter: band, after: { phase: 1, value: null, id: ID } })).sql;
    expect(after).toMatch(/where false/);
    // Bounds that leave nulls possible keep the null phase: another field, an `or` with an unbounded branch, a `not`.
    const unbounded: Filter[] = [
      { op: 'range', field: 'beds', gte: 2 },
      { op: 'or', filters: [band, network] },
      { op: 'not', filter: band },
    ];
    for (const filter of unbounded) {
      expect(render(fallbackSearchSql({ ...base, filter })).sql, JSON.stringify(filter)).toContain(
        'price_cents is null',
      );
    }
    expect(
      requiresValue({ op: 'or', filters: [band, { op: 'in', field: 'priceCents', values: [5] }] }, 'priceCents'),
    ).toBe(true);
    expect(requiresValue({ op: 'geoBox', north: 1, south: 0, west: 0, east: 1 }, 'priceCents')).toBe(false);
  });

  it('[S7-F9] requiresValue holds because the compiler never matches a null on a range, eq or in', () => {
    // `requiresValue` treats these three as "the column has a value"; the SQL they compile to must say so.
    expect(render(fallbackCondition({ op: 'range', field: 'priceCents', gte: 1 })).sql).toMatch(
      /^\(price_cents is not null and /,
    );
    expect(render(fallbackCondition({ op: 'range', field: 'areaM2', lte: 9 })).sql).toMatch(
      /^\(\(area_m2::float8\) is not null and /,
    );
    expect(render(fallbackCondition({ op: 'eq', field: 'beds', value: 2 })).sql).toBe('beds = $1');
    expect(render(fallbackCondition({ op: 'in', field: 'beds', values: [2, 3] })).sql).toBe(
      'beds = any(array[$1, $2]::int[])',
    );
    for (const filter of [
      { op: 'range', field: 'priceCents', gte: 1 },
      { op: 'eq', field: 'priceCents', value: 1 },
      { op: 'in', field: 'priceCents', values: [1] },
    ] as Filter[]) {
      expect(requiresValue(filter, 'priceCents')).toBe(true);
    }
  });

  it('[S7-F11] areas compare and sort as float8 (leakproof: the planner has statistics for them under RLS)', () => {
    const band = render(fallbackCondition({ op: 'range', field: 'areaM2', gte: 100.5, lte: 200 }));
    expect(band.sql).toBe('((area_m2::float8) is not null and (area_m2::float8) >= $1 and (area_m2::float8) <= $2)');
    expect(band.params).toEqual([100.5, 200]);
    expect(render(fallbackCondition({ op: 'range', field: 'plotM2', gte: 500 })).sql).toBe(
      '((plot_m2::float8) is not null and (plot_m2::float8) >= $1)',
    );
    expect(render(fallbackCondition({ op: 'in', field: 'areaM2', values: [90, 100] })).sql).toBe(
      '(area_m2::float8) = any(array[$1, $2]::float8[])',
    );
    // Never a `numeric` comparison (no statistics under the table's policy), and never a bad value.
    expect(() => fallbackCondition({ op: 'range', field: 'areaM2', gte: Number.NaN })).toThrow(SearchError);
    // The sort walks the expression index (`area_f8_idx`): order, keyset and null phase on the same expression.
    const page = render(
      fallbackSearchSql({
        filter: { op: 'range', field: 'plotM2', gte: 500, lte: 1500 },
        sort: { field: 'areaM2', dir: 'desc' },
        limit: 24,
        after: { phase: 0, value: 120.25, id: ID },
        countCap: 1000,
      }),
    ).sql;
    expect(page).toContain('order by (area_m2::float8) desc, target_id desc');
    expect(page).toMatch(/and \(\(area_m2::float8\), target_id\) < \(\$\d+::float8, \$\d+::uuid\)/);
    // The keyset value takes the sort column's own type (a price keyset stays an index condition on `price_idx`).
    const byPrice = render(
      fallbackSearchSql({
        filter: { op: 'range', field: 'beds', gte: 1 },
        sort: { field: 'priceCents', dir: 'asc' },
        limit: 24,
        after: { phase: 0, value: 30_000_000, id: ID },
        countCap: 1000,
      }),
    ).sql;
    expect(byPrice).toMatch(/and \(price_cents, target_id\) > \(\$\d+::bigint, \$\d+::uuid\)/);
    expect(page).toContain('(area_m2::float8) is null');
    expect(page).not.toMatch(/\b(?:area|plot)_m2 (?:is|>=|<=|<|>|=)/);
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
