import { loadStackEnv } from '@inmolink/db/testing';
import { createMeiliEngine, type IndexDefinition, type SearchEngine, SearchError } from '@inmolink/platform/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const uid = `t_search_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let engine: SearchEngine;

const def: IndexDefinition = {
  uid,
  primaryKey: 'id',
  searchable: ['ref', 'title_es', 'title_en'],
  filterable: [
    { field: 'id', comparison: true },
    { field: 'status' },
    { field: 'tags' },
    { field: 'owner' },
    { field: 'price', comparison: true },
  ],
  sortable: ['price', 'id'],
  localized: [
    { fields: ['title_es'], locale: 'es' },
    { fields: ['title_en'], locale: 'en' },
  ],
  displayed: ['id'],
  exactOn: ['ref'],
  geo: true,
  maxTotalHits: 1000,
  maxValuesPerFacet: 50,
};

const docs = [
  {
    id: 'a',
    ref: 'R-1',
    title_es: 'Villa con piscina',
    title_en: 'Villa with pool',
    status: 'ACTIVE',
    tags: ['pool', 'sea'],
    owner: 'o1',
    price: 500,
    geo: { lat: 36.51, lng: -4.88 },
  },
  {
    id: 'b',
    ref: 'R-2',
    title_es: 'Ático en el centro',
    title_en: 'Penthouse downtown',
    status: 'ACTIVE',
    tags: ['sea'],
    owner: 'o2',
    price: 300,
    geo: { lat: 40.41, lng: -3.7 },
  },
  {
    id: 'c',
    ref: 'R-3',
    title_es: 'Casa adosada',
    title_en: 'Townhouse',
    status: 'SOLD',
    tags: [],
    owner: 'o"1',
    price: null,
    geo: null,
  },
];

beforeAll(async () => {
  loadStackEnv('test');
  engine = createMeiliEngine({
    url: process.env.MEILI_URL as string,
    apiKey: process.env.MEILI_MASTER_KEY as string,
  });
});

afterAll(async () => {
  await engine.dropIndex(uid);
});

describe('platform/search (Meilisearch)', () => {
  it('[S5-02] index settings are idempotently applied: created once, unchanged settings send nothing', async () => {
    const first = await engine.ensureIndex(def);
    expect(first.created).toBe(true);
    expect(first.changed.length).toBeGreaterThan(0);

    const again = await engine.ensureIndex(def);
    expect(again).toEqual({ created: false, changed: [] });

    // A definition change applies only the setting that changed.
    const changed = await engine.ensureIndex({ ...def, sortable: ['price', 'ref'] });
    expect(changed).toEqual({ created: false, changed: ['sortableAttributes'] });
    expect(await engine.ensureIndex(def)).toEqual({ created: false, changed: ['sortableAttributes'] });
  });

  it('[S5-02] upsert, filter, facet, geo, sort, fetch, stats and delete', async () => {
    await engine.ensureIndex(def);
    await engine.waitForTask(await engine.upsert(uid, docs));

    const active = await engine.search(def, {
      filter: { op: 'eq', field: 'status', value: 'ACTIVE' },
      facets: ['tags', 'price'],
      sort: [{ field: 'price', dir: 'asc' }],
      limit: 10,
    });
    expect(active.ids).toEqual(['b', 'a']);
    expect(active.total).toBe(2);
    expect(active.facets.tags).toEqual({ sea: 2, pool: 1 });
    expect(active.facetStats.price).toEqual({ min: 300, max: 500 });

    const text = await engine.search(def, { text: 'piscina', searchOn: ['title_es'], locale: 'es', limit: 10 });
    expect(text.ids).toEqual(['a']);
    // The English field is not searched when the query names the Spanish one.
    expect((await engine.search(def, { text: 'pool', searchOn: ['title_es'], limit: 10 })).ids).toEqual([]);

    const near = await engine.search(def, {
      filter: { op: 'geoRadius', lat: 36.5, lng: -4.9, meters: 10_000 },
      limit: 10,
    });
    expect(near.ids).toEqual(['a']);
    const box = await engine.search(def, {
      filter: { op: 'geoBox', north: 41, west: -4, south: 40, east: -3 },
      limit: 10,
    });
    expect(box.ids).toEqual(['b']);
    expect((await engine.search(def, { sort: [{ geoNear: { lat: 40.4, lng: -3.7 } }], limit: 1 })).ids).toEqual(['b']);

    const range = await engine.search(def, { filter: { op: 'range', field: 'price', gte: 400 }, limit: 10 });
    expect(range.ids).toEqual(['a']);

    // A value with quotes matches literally and cannot widen the filter.
    const quoted = await engine.search(def, { filter: { op: 'eq', field: 'owner', value: 'o"1' }, limit: 10 });
    expect(quoted.ids).toEqual(['c']);
    const injection = await engine.search(def, {
      filter: { op: 'eq', field: 'owner', value: 'x" OR status = "ACTIVE' },
      limit: 10,
    });
    expect(injection.ids).toEqual([]);

    // Answers carry ids only.
    const fetched = await engine.fetch(uid, ['a', 'zzz'], ['id', 'price']);
    expect(fetched).toEqual([{ id: 'a', price: 500 }]);
    expect(await engine.stats(uid)).toMatchObject({ documents: 3 });
    // [S5-03] the repair walk pages through every document's id — [S6-F2] by id, after the last one seen.
    const first = await engine.browse(def, { after: null, limit: 2, fields: ['id'] });
    expect(first.results.map((d) => d.id)).toEqual(['a', 'b']);
    expect(first.total).toBe(3);
    const rest = await engine.browse(def, { after: 'b', limit: 2, fields: ['id'] });
    expect(rest.results.map((d) => d.id)).toEqual(['c']);
    await expect(
      engine.browse({ ...def, sortable: ['price'] }, { after: null, limit: 2, fields: ['id'] }),
    ).rejects.toThrow(SearchError);
    const plainKey = def.filterable.map((f) => (f.field === 'id' ? { field: 'id' } : f));
    await expect(
      engine.browse({ ...def, filterable: plainKey }, { after: null, limit: 2, fields: ['id'] }),
    ).rejects.toThrow(/not comparable/);

    await engine.waitForTask(await engine.delete(uid, ['a', 'missing']));
    expect(await engine.stats(uid)).toMatchObject({ documents: 2 });
  });

  it('[S5-02] refuses undeclared fields before calling the engine, and reports engine errors', async () => {
    await expect(
      engine.search(def, { filter: { op: 'eq', field: 'secret', value: 'x' }, limit: 1 }),
    ).rejects.toBeInstanceOf(SearchError);
    await expect(engine.search(def, { facets: ['secret'], limit: 1 })).rejects.toThrow(/not facetable/);
    await expect(engine.search(def, { text: 'x', searchOn: ['owner'], limit: 1 })).rejects.toThrow(/not searchable/);
    expect(await engine.stats(`${uid}_missing`)).toBeNull();
    const bad = createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: 'wrong-key' });
    await expect(bad.search(def, { limit: 1 })).rejects.toMatchObject({ name: 'SearchError', status: 403 });
    expect(await engine.health()).toBe(true);
  });

  it('[S5-02] a settings change still running (an earlier call gave up waiting) is waited for, never queued again', async () => {
    const other = { ...def, uid: `${uid}_pending` };
    const settingsTasks = async () => {
      const res = await fetch(`${process.env.MEILI_URL}/tasks?indexUids=${other.uid}&types=settingsUpdate&limit=1`, {
        headers: { Authorization: `Bearer ${process.env.MEILI_MASTER_KEY}` },
      });
      return ((await res.json()) as { total: number }).total;
    };
    try {
      await engine.ensureIndex(other);
      // Keep the engine busy so the next settings task waits in its queue (like a reindex of 2M documents).
      const filler = Array.from({ length: 30_000 }, (_, i) => ({
        id: `f${i}`,
        ref: `F${i}`,
        title_es: `relleno ${i}`,
      }));
      await engine.upsert(other.uid, filler);
      const next = { ...other, searchable: ['ref', 'title_en', 'title_es'] };
      await expect(engine.ensureIndex(next, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'timeout' });
      const queued = await settingsTasks();

      expect(await engine.ensureIndex(next)).toEqual({ created: false, changed: [] });
      expect(await settingsTasks()).toBe(queued);
    } finally {
      await engine.dropIndex(other.uid);
    }
  });

  it('[S5-02] backslashes and quotes in values match literally; empty writes send nothing', async () => {
    await engine.ensureIndex(def);
    await engine.waitForTask(await engine.upsert(uid, [{ id: 'bs', ref: 'BS', status: 'X', owner: 'pq"', geo: null }]));
    const found = await engine.search(def, { filter: { op: 'eq', field: 'owner', value: 'pq"' }, limit: 10 });
    expect(found.ids).toEqual(['bs']);
    expect(await engine.upsert(uid, [])).toBeNull();
    expect(await engine.delete(uid, [])).toBeNull();
    await engine.waitForTask(null);
  });
});
