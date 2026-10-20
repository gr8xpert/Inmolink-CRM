import { SearchError } from '@inmolink/platform/search';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { fallbackCondition, fallbackSearchSql } from '../repo';

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
