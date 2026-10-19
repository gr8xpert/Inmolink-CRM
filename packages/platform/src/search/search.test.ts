import { describe, expect, it } from 'vitest';
import { compileFilter, type IndexDefinition, meiliSettings, SearchError, settingsDiff } from './index';

const def: IndexDefinition = {
  uid: 'test',
  primaryKey: 'id',
  searchable: ['ref', 'title_es', 'title_en'],
  filterable: [{ field: 'status' }, { field: 'tags' }, { field: 'price', comparison: true }],
  sortable: ['price'],
  localized: [
    { fields: ['title_es'], locale: 'es' },
    { fields: ['title_xx'], locale: 'xx' },
  ],
  displayed: ['id'],
  exactOn: ['ref'],
  geo: true,
  maxTotalHits: 1000,
  maxValuesPerFacet: 100,
};

describe('platform/search filters', () => {
  it('[S5-02] compiles and/or/not, in, range and geo', () => {
    expect(
      compileFilter(def, {
        op: 'and',
        filters: [
          { op: 'eq', field: 'status', value: 'ACTIVE' },
          { op: 'in', field: 'tags', values: ['a', 2, true] },
          { op: 'range', field: 'price', gte: 100, lte: 200 },
          { op: 'not', filter: { op: 'eq', field: 'status', value: 'SOLD' } },
          { op: 'geoRadius', lat: 36.5, lng: -4.9, meters: 2500.4 },
        ],
      }),
    ).toBe(
      '(status = "ACTIVE" AND tags IN ["a", 2, true] AND (price >= 100 AND price <= 200) AND (NOT status = "SOLD") AND _geoRadius(36.5, -4.9, 2500))',
    );
    expect(compileFilter(def, { op: 'geoBox', north: 37, west: -5, south: 36, east: -4 })).toBe(
      '_geoBoundingBox([37, -4], [36, -5])',
    );
  });

  it('[S5-02] quotes values so input cannot change the filter structure', () => {
    expect(compileFilter(def, { op: 'eq', field: 'status', value: 'x" OR status = "y\\' })).toBe(
      'status = "x\\" OR status = \\"y\\\\"',
    );
  });

  it('[S5-02] refuses undeclared fields, comparisons on equality fields and non-finite numbers', () => {
    expect(() => compileFilter(def, { op: 'eq', field: 'agencyId', value: 'a' })).toThrow(SearchError);
    expect(() => compileFilter(def, { op: 'range', field: 'status', gte: 1 })).toThrow(/not comparable/);
    expect(() => compileFilter(def, { op: 'range', field: 'price', gte: Number.NaN })).toThrow(/finite/);
    expect(() => compileFilter(def, { op: 'in', field: 'tags', values: [] })).toThrow(/empty/);
    expect(() => compileFilter({ ...def, geo: false }, { op: 'geoRadius', lat: 1, lng: 1, meters: 1 })).toThrow(/geo/);
  });

  it('[S6-F2] gt compares strings (keyset walks) on comparable fields only, quoted', () => {
    expect(compileFilter(def, { op: 'gt', field: 'price', value: 'a"b' })).toBe('price > "a\\"b"');
    expect(compileFilter(def, { op: 'gt', field: 'price', value: 5 })).toBe('price > 5');
    expect(() => compileFilter(def, { op: 'gt', field: 'status', value: 'x' })).toThrow(/not comparable/);
  });
});

describe('platform/search settings', () => {
  it('[S5-02] maps locales to engine languages and leaves unknown ones unhinted', () => {
    const s = meiliSettings(def);
    expect(s.localizedAttributes).toEqual([{ attributePatterns: ['title_es'], locales: ['spa'] }]);
    expect(s.sortableAttributes).toEqual(['price', '_geo']);
    expect(s.filterableAttributes).toEqual([
      {
        attributePatterns: ['status', 'tags'],
        features: { facetSearch: false, filter: { equality: true, comparison: false } },
      },
      { attributePatterns: ['price'], features: { facetSearch: false, filter: { equality: true, comparison: true } } },
      '_geo',
    ]);
  });

  it('[S5-02] diff ignores engine defaults and set order, and catches real changes', () => {
    const desired = meiliSettings(def);
    const echoed = {
      ...structuredClone(desired),
      sortableAttributes: ['_geo', 'price'],
      typoTolerance: { enabled: true, disableOnAttributes: ['ref'], disableOnWords: [] },
      rankingRules: ['words'],
    };
    expect(settingsDiff(echoed, desired)).toEqual([]);
    expect(settingsDiff({ ...echoed, searchableAttributes: ['title_es', 'ref', 'title_en'] }, desired)).toEqual([
      'searchableAttributes',
    ]);
    expect(settingsDiff({}, desired)).toEqual(Object.keys(desired));
  });
});
