import { LegacyTaxonomyExtract } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { legacyIdMaps } from '@inmolink/db/schema/migration';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as taxonomy from '../../taxonomy';
import * as migration from '../index';

/** Legacy taxonomy import on the real test database (S2-06). */

const RUN = newId().slice(-8).toLowerCase();
/** Letters only, so names stay clean for trigram scores and are unlike any earlier run's data. */
const word = () => Array.from({ length: 10 }, () => 'bcdfghjklmnpqrstvwxz'[Math.floor(Math.random() * 20)]).join('');
const W = { country: word(), region: word(), city: word(), area: word(), long: word(), type: word(), feat: word() };
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('migration.test', fn);

const NAMES = {
  country: `Reino ${W.country}`,
  region: `Costa ${W.region}`,
  city: `Puerto ${W.city}`,
  area: `Barrio ${W.area}`,
  long: `Urbanizacion Los Cipreses ${W.long} Dorados`,
  twinA: `Gemela ${W.city}`,
};

let ids: Record<string, string> = {};
let typeId = '';
let featureId = '';

beforeAll(async () => {
  await setupTestDb('worker');
  await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('lg-c'),
      translations: tr(NAMES.country, 'lg-country'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('lg-r'),
      translations: tr(NAMES.region, 'lg-region'),
    });
    const regionB = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('lg-rb'),
      translations: tr(`Sierra ${W.region}`, 'lg-region-b'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('lg-ci'),
      translations: tr(NAMES.city, 'lg-city'),
    });
    const area = await taxonomy.createLocation(tx, {
      level: 'AREA',
      parentId: city,
      code: code('lg-a'),
      translations: tr(NAMES.area, 'lg-area'),
    });
    const long = await taxonomy.createLocation(tx, {
      level: 'AREA',
      parentId: city,
      code: code('lg-l'),
      translations: tr(NAMES.long, 'lg-long'),
    });
    // The same town name under two regions: only the parent tells them apart.
    const twinA = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('lg-ta'),
      translations: tr(NAMES.twinA, 'lg-twin'),
    });
    const twinB = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: regionB,
      code: code('lg-tb'),
      translations: tr(NAMES.twinA, 'lg-twin'),
    });
    ids = { country, region, regionB, city, area, long, twinA, twinB };
    const tg = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('lg-houses'),
      sort: 0,
      translations: tr(`Casas ${W.type}`, 'lg-houses'),
    });
    typeId = await taxonomy.createPropertyType(tx, {
      groupId: tg,
      key: code('lg-villa'),
      sort: 0,
      translations: tr(`Chalet ${W.type}`, 'lg-villa'),
    });
    const fg = await taxonomy.createFeatureGroup(tx, {
      key: code('lg-outdoor'),
      sort: 0,
      translations: tr(`Exterior ${W.feat}`, 'lg-outdoor'),
    });
    featureId = await taxonomy.createFeature(tx, {
      groupId: fg,
      key: code('lg-pool'),
      icon: 'waves',
      sort: 0,
      translations: tr(`Piscina ${W.feat}`, 'lg-pool'),
    });
  });
});

afterAll(closeDb);

function extract() {
  const L = (id: string, name: string, parentId: string | null, extra: object = {}) => ({
    id,
    name,
    parentId,
    names: {},
    aliases: [],
    ...extra,
  });
  return {
    locations: [
      L(`${RUN}-1`, NAMES.country.toUpperCase(), null),
      L(`${RUN}-2`, NAMES.region, `${RUN}-1`, { aliases: [`${NAMES.region} Sur`] }),
      L(`${RUN}-3`, NAMES.city.replace('Puerto', 'Púerto'), `${RUN}-2`, { names: { es: `Pto ${W.city}` } }),
      L(`${RUN}-4`, NAMES.area, `${RUN}-3`),
      // one typo in a long name: confident fuzzy match, so the legacy spelling becomes an alias
      L(`${RUN}-5`, NAMES.long.replace('Cipreses', 'Cipreces'), `${RUN}-3`),
      // shared town name: resolved through the legacy parent
      L(`${RUN}-6`, NAMES.twinA, `${RUN}-7`),
      L(`${RUN}-7`, `Sierra ${W.region}`, `${RUN}-1`),
      // nothing like it in v2
      L(`${RUN}-8`, `Zzz ${word()} ${word()}`, `${RUN}-3`),
      // parent missing from the extract
      L(`${RUN}-9`, `Huerfano ${word()}`, `${RUN}-404`),
      // parent unmapped
      L(`${RUN}-10`, `Hijo ${word()}`, `${RUN}-8`),
    ],
    propertyTypes: [
      { id: 't1', name: `Chalet ${W.type}`, names: {}, aliases: [`Chalet Indep ${W.type}`] },
      { id: 't2', name: `Castillo ${word()}`, names: {}, aliases: [] },
    ],
    features: [{ id: 'f1', name: `Piscina ${W.feat}`, names: { es: `Alberca ${W.feat}` }, aliases: [] }],
  };
}

const run = (opts?: migration.ImportOptions) =>
  system((tx) => migration.importLegacyTaxonomy(tx, LegacyTaxonomyExtract.parse(extract()), opts));
const mapsOf = (entity: string, legacyIds: string[]) =>
  system((tx) =>
    tx
      .select({ legacyId: legacyIdMaps.legacyId, newId: legacyIdMaps.newId, entity: legacyIdMaps.entity })
      .from(legacyIdMaps)
      .where(inArray(legacyIdMaps.legacyId, legacyIds)),
  ).then((rows) => new Map(rows.filter((r) => r.entity === entity).map((r) => [r.legacyId, r.newId])));

describe('legacy taxonomy import', () => {
  it('[S2-06] dry run reports without writing aliases or maps', async () => {
    const report = await run({ dryRun: true });
    expect(report.counts.location?.mapped).toBeGreaterThan(0);
    expect(report.aliasesAdded).toBeGreaterThan(0);
    expect((await mapsOf('location', [`${RUN}-1`])).size).toBe(0);
    expect(
      await system((tx) => taxonomy.resolveMany(tx, 'location', [NAMES.long.replace('Cipreses', 'Cipreces')])),
    ).toEqual([expect.objectContaining({ status: 'fuzzy' })]);
  });

  it('[S2-06] every legacy ID maps to a new ID or is reported with a reason', async () => {
    const report = await run();
    const x = extract();
    const all = {
      location: x.locations.map((l) => l.id),
      propertyType: x.propertyTypes.map((l) => l.id),
      feature: x.features.map((l) => l.id),
    } as const;
    for (const entity of ['location', 'propertyType', 'feature'] as const) {
      const maps = await mapsOf(entity, [...all[entity]]);
      const reported = new Set(report.unmapped.filter((u) => u.entity === entity).map((u) => u.legacyId));
      for (const legacyId of all[entity]) {
        expect(maps.has(legacyId) !== reported.has(legacyId), `${entity} ${legacyId}`).toBe(true);
      }
      expect(report.counts[entity]?.total).toBe(all[entity].length);
      expect(report.counts[entity]?.mapped).toBe(maps.size);
    }
    for (const u of report.unmapped) expect(u.reason).toBeTruthy();
  });

  it('[S2-06] maps exact names, accent and case variants, and a parent-disambiguated shared name', async () => {
    const m = await mapsOf(
      'location',
      [1, 2, 3, 4, 6, 7].map((n) => `${RUN}-${n}`),
    );
    expect(m.get(`${RUN}-1`)).toBe(ids.country);
    expect(m.get(`${RUN}-2`)).toBe(ids.region);
    expect(m.get(`${RUN}-3`)).toBe(ids.city);
    expect(m.get(`${RUN}-4`)).toBe(ids.area);
    expect(m.get(`${RUN}-6`)).toBe(ids.twinB); // its legacy parent maps to regionB
    expect(m.get(`${RUN}-7`)).toBe(ids.regionB);
  });

  it('[S2-06] writes an alias for every legacy spelling that did not already resolve', async () => {
    const spellings = [
      NAMES.long.replace('Cipreses', 'Cipreces'),
      `${NAMES.region} Sur`,
      `Pto ${W.city}`,
      `Chalet Indep ${W.type}`,
    ];
    const [loc, type] = await system(async (tx) => [
      await taxonomy.resolveMany(tx, 'location', spellings.slice(0, 3)),
      await taxonomy.resolveMany(tx, 'propertyType', [spellings[3] as string]),
    ]);
    expect(loc?.map((r) => r.status)).toEqual(['exact', 'exact', 'exact']);
    expect(loc?.[0]?.id).toBe(ids.long);
    expect(loc?.[1]?.id).toBe(ids.region);
    expect(loc?.[2]?.id).toBe(ids.city);
    expect(type?.[0]).toMatchObject({ status: 'exact', id: typeId });
    const feat = await system((tx) => taxonomy.resolveMany(tx, 'feature', [`Alberca ${W.feat}`]));
    expect(feat[0]).toMatchObject({ status: 'exact', id: featureId });
  });

  it('[S2-06] lists unmatched, orphaned and orphan-child rows with their reasons', async () => {
    const report = await run();
    const by = new Map(report.unmapped.map((u) => [u.legacyId, u]));
    expect(by.get(`${RUN}-8`)?.reason).toBe('no_match');
    expect(by.get(`${RUN}-9`)?.reason).toBe('invalid');
    expect(by.get(`${RUN}-10`)).toMatchObject({ reason: 'no_match', parentUnmapped: true });
    expect(by.get('t2')?.reason).toBe('no_match');
    expect(
      report.unmapped.every((u) => ['invalid', 'no_match', 'ambiguous', 'low_confidence'].includes(u.reason)),
    ).toBe(true);
  });

  it('[S2-06] is idempotent: a re-run adds no aliases and changes no maps', async () => {
    const before = await mapsOf(
      'location',
      [1, 2, 3, 4, 5, 6, 7].map((n) => `${RUN}-${n}`),
    );
    const report = await run();
    expect(report.aliasesAdded).toBe(0);
    expect(report.remapped).toBe(0);
    expect(
      await mapsOf(
        'location',
        [1, 2, 3, 4, 5, 6, 7].map((n) => `${RUN}-${n}`),
      ),
    ).toEqual(before);
    expect(report.aliasConflicts).toEqual([]);
  });

  it('[S2-06] a map that pointed elsewhere is replaced and counted', async () => {
    await system((tx) =>
      tx
        .insert(legacyIdMaps)
        .values({ id: newId(), entity: 'feature', legacyId: 'f1', newId: newId(), method: 'manual' })
        .onConflictDoUpdate({ target: [legacyIdMaps.entity, legacyIdMaps.legacyId], set: { newId: newId() } }),
    );
    const report = await run();
    expect(report.remapped).toBe(1);
    expect((await mapsOf('feature', ['f1'])).get('f1')).toBe(featureId);
  });
});
