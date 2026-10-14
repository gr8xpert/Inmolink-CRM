import { LegacyTaxonomyExtract, type LegacyTaxonomyReport } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { legacyIdMaps } from '@inmolink/db/schema/migration';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as taxonomy from '../../taxonomy';
import * as migration from '../index';

/** Legacy taxonomy import on the real test database (S2-06). */

const RUN = newId().slice(-8).toLowerCase();
/** Letters only, so names stay clean for trigram scores and are unlike any earlier run's data. */
const word = () => Array.from({ length: 10 }, () => 'bcdfghjklmnpqrstvwxz'[Math.floor(Math.random() * 20)]).join('');
const W = { country: word(), region: word(), city: word(), area: word(), long: word(), type: word(), feat: word() };
/** Fixed per run, so every call of `extract()` describes the same legacy data. */
const X = Array.from({ length: 7 }, word);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('migration.test', fn);
const lid = (n: number) => `${RUN}-${n}`;

const NAMES = {
  country: `Reino ${W.country}`,
  region: `Costa ${W.region}`,
  regionB: `Sierra ${W.region}`,
  city: `Puerto ${W.city}`,
  area: `Barrio ${W.area}`,
  long: `Urbanizacion Los Cipreses ${W.long} Dorados`,
  twin: `Gemela ${W.city}`,
  villa: `Villa ${W.area}`,
  clash: `Atajo ${W.city}`,
};
const LONG_TYPO = NAMES.long.replace('Cipreses', 'Cipreces');
// two letters changed in a short name: a close candidate, below the accept threshold
const AREA_TYPO = `${NAMES.area.slice(0, -2)}aa`;

let ids: Record<string, string> = {};
let typeId = '';
let featureId = '';
const MANUAL_TARGET = newId();

function extract() {
  const L = (n: number, name: string, parent: number | string | null, extra: object = {}) => ({
    id: lid(n),
    name,
    parentId: typeof parent === 'number' ? lid(parent) : parent,
    names: {},
    aliases: [],
    ...extra,
  });
  return {
    locations: [
      L(1, NAMES.country.toUpperCase(), null),
      L(2, NAMES.region, 1, { aliases: [`${NAMES.region} Sur`] }),
      L(3, NAMES.city.replace('Puerto', 'Púerto'), 2, { names: { es: `Pto ${W.city}` } }),
      L(4, NAMES.area, 3),
      L(5, LONG_TYPO, 3), // one typo in a long name: confident fuzzy match
      L(6, NAMES.twin, 7, { aliases: [NAMES.clash] }), // shared name, told apart by its parent
      L(7, NAMES.regionB, 1),
      L(8, `Zzz ${X[0]} ${X[1]}`, 3), // nothing like it
      L(9, `Huerfano ${X[2]}`, `${RUN}-404`), // parent missing from the extract
      L(10, `Hijo ${X[3]}`, 8), // parent unmapped
      L(11, NAMES.twin, null), // shared name, no parent to tell them apart
      L(12, AREA_TYPO, 3),
      L(13, `Ciclo ${X[4]}`, 14), // a cycle
      L(14, `Ciclo ${X[5]}`, 13),
      L(15, NAMES.villa, 2), // exists, but under regionB, not under the region legacy row 2 maps to
    ],
    propertyTypes: [
      { id: lid(101), name: `Chalet ${W.type}`, names: {}, aliases: [`Chalet Indep ${W.type}`] },
      { id: lid(102), name: `Castillo ${X[6]}`, names: {}, aliases: [] },
      { id: lid(103), name: `Chalet ${W.type}`, names: {}, aliases: [] }, // kept on its manual map
    ],
    features: [{ id: lid(201), name: `Piscina ${W.feat}`, names: { es: `Alberca ${W.feat}` }, aliases: [] }],
  };
}
const ALL = (() => {
  const x = extract();
  return {
    location: x.locations.map((l) => l.id),
    propertyType: x.propertyTypes.map((l) => l.id),
    feature: x.features.map((l) => l.id),
  };
})();

const run = (opts?: migration.ImportOptions) =>
  system((tx) => migration.importLegacyTaxonomy(tx, LegacyTaxonomyExtract.parse(extract()), opts));
const mapsOf = (entity: string, legacyIds: string[]) =>
  system((tx) =>
    tx
      .select({ legacyId: legacyIdMaps.legacyId, newId: legacyIdMaps.newId })
      .from(legacyIdMaps)
      .where(and(eq(legacyIdMaps.entity, entity), inArray(legacyIdMaps.legacyId, legacyIds))),
  ).then((rows) => new Map(rows.map((r) => [r.legacyId, r.newId])));

let dry: LegacyTaxonomyReport;
let dryMaps: Map<string, string>;
let dryLong: taxonomy.Resolution;
let first: LegacyTaxonomyReport;

beforeAll(async () => {
  await setupTestDb('worker');
  await system(async (tx) => {
    // codes are unique; slugs only per parent (the twins share theirs)
    let n = 0;
    const loc = (level: 'COUNTRY' | 'REGION' | 'CITY' | 'AREA', parentId: string | null, name: string, k: string) =>
      taxonomy.createLocation(tx, { level, parentId, code: code(`lg${++n}`), translations: tr(name, k) });
    const country = await loc('COUNTRY', null, NAMES.country, 'lg-c');
    const region = await loc('REGION', country, NAMES.region, 'lg-r');
    const regionB = await loc('REGION', country, NAMES.regionB, 'lg-rb');
    const city = await loc('CITY', region, NAMES.city, 'lg-ci');
    const area = await loc('AREA', city, NAMES.area, 'lg-a');
    const long = await loc('AREA', city, NAMES.long, 'lg-l');
    const twinA = await loc('CITY', region, NAMES.twin, 'lg-twin');
    const twinB = await loc('CITY', regionB, NAMES.twin, 'lg-twin');
    const villa = await loc('CITY', regionB, NAMES.villa, 'lg-villa');
    // a spelling some other location already owns
    await taxonomy.addLocationAlias(tx, city, NAMES.clash);
    ids = { country, region, regionB, city, area, long, twinA, twinB, villa };
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
    await tx.insert(legacyIdMaps).values([
      { id: newId(), entity: 'feature', legacyId: lid(201), newId: newId(), method: 'exact' }, // stale
      { id: newId(), entity: 'propertyType', legacyId: lid(103), newId: MANUAL_TARGET, method: 'manual' },
    ]);
  });
  dry = await run({ dryRun: true });
  dryMaps = await mapsOf('location', ALL.location);
  [dryLong] = (await system((tx) => taxonomy.resolveMany(tx, 'location', [LONG_TYPO]))) as [taxonomy.Resolution];
  first = await run();
});

afterAll(closeDb);

describe('legacy taxonomy import', () => {
  it('[S2-06] dry run reports without writing aliases or maps', () => {
    expect(dry.counts.location?.mapped).toBe(first.counts.location?.mapped);
    expect(dry.aliasesAdded).toBeGreaterThan(0);
    expect(dryMaps.size).toBe(0);
    expect(dryLong.status).toBe('fuzzy'); // no alias was written for it yet
  });

  it('[S2-06] every legacy ID maps to a new ID or is reported with a reason', async () => {
    for (const entity of ['location', 'propertyType', 'feature'] as const) {
      const maps = await mapsOf(entity, ALL[entity]);
      const reported = new Set(first.unmapped.filter((u) => u.entity === entity).map((u) => u.legacyId));
      for (const legacyId of ALL[entity]) {
        expect(maps.has(legacyId) !== reported.has(legacyId), `${entity} ${legacyId}`).toBe(true);
      }
      expect(first.counts[entity]?.total).toBe(ALL[entity].length);
      expect(first.counts[entity]?.mapped).toBe(maps.size);
    }
  });

  it('[S2-06] maps exact names, accent and case variants, and a parent-disambiguated shared name', async () => {
    const m = await mapsOf('location', ALL.location);
    expect(m.get(lid(1))).toBe(ids.country);
    expect(m.get(lid(2))).toBe(ids.region);
    expect(m.get(lid(3))).toBe(ids.city);
    expect(m.get(lid(4))).toBe(ids.area);
    expect(m.get(lid(5))).toBe(ids.long);
    expect(m.get(lid(6))).toBe(ids.twinB); // its legacy parent maps to regionB
    expect(m.get(lid(7))).toBe(ids.regionB);
    expect(first.counts.location).toMatchObject({ exact: 6, fuzzy: 1 });
  });

  it('[S2-06] writes an alias for every legacy spelling that did not already resolve', async () => {
    const loc = await system((tx) =>
      taxonomy.resolveMany(tx, 'location', [LONG_TYPO, `${NAMES.region} Sur`, `Pto ${W.city}`]),
    );
    expect(loc.map((r) => [r.status, r.id])).toEqual([
      ['exact', ids.long],
      ['exact', ids.region],
      ['exact', ids.city],
    ]);
    const [type] = await system((tx) => taxonomy.resolveMany(tx, 'propertyType', [`Chalet Indep ${W.type}`]));
    expect(type).toMatchObject({ status: 'exact', id: typeId });
    const [feat] = await system((tx) => taxonomy.resolveMany(tx, 'feature', [`Alberca ${W.feat}`]));
    expect(feat).toMatchObject({ status: 'exact', id: featureId });
  });

  it('[S2-06] lists unmapped rows with their reasons', () => {
    const by = new Map(first.unmapped.map((u) => [u.legacyId, u]));
    expect(by.get(lid(8))?.reason).toBe('no_match');
    expect(by.get(lid(9))?.reason).toBe('invalid');
    expect(by.get(lid(10))).toMatchObject({ reason: 'no_match', parentUnmapped: true });
    expect(by.get(lid(11))?.reason).toBe('ambiguous');
    expect(by.get(lid(12))).toMatchObject({ reason: 'low_confidence', candidateId: ids.area });
    expect(by.get(lid(13))?.reason).toBe('invalid');
    expect(by.get(lid(14))?.reason).toBe('invalid');
    expect(by.get(lid(15))).toMatchObject({ reason: 'parent_mismatch', candidateId: ids.villa });
    expect(by.get(lid(102))?.reason).toBe('no_match');
  });

  it('[S2-06] a spelling another entry owns is reported as a conflict, not written, and does not abort the run', () => {
    expect(first.aliasConflicts).toContainEqual({
      entity: 'location',
      legacyId: lid(6),
      spelling: NAMES.clash,
      ownerId: ids.city,
    });
  });

  it('[S2-06] the bulk alias write skips owned spellings instead of failing', async () => {
    const res = await system((tx) =>
      taxonomy.importAliases(tx, 'location', [
        { ownerId: ids.area as string, alias: NAMES.clash },
        { ownerId: ids.area as string, alias: `Nuevo ${word()}` },
      ]),
    );
    expect(res.inserted.size).toBe(1);
    expect(res.owners.get(taxonomy.aliasKey(NAMES.clash))).toBe(ids.city);
  });

  it('[S2-06] a stale map is replaced and counted; a manual map is kept', async () => {
    expect(first.remapped).toBe(1);
    expect((await mapsOf('feature', [lid(201)])).get(lid(201))).toBe(featureId);
    expect((await mapsOf('propertyType', [lid(103)])).get(lid(103))).toBe(MANUAL_TARGET);
  });

  it('[S2-06] is idempotent: a re-run adds no aliases and changes no maps', async () => {
    const before = await mapsOf('location', ALL.location);
    const again = await run();
    expect(again.aliasesAdded).toBe(0);
    expect(again.remapped).toBe(0);
    expect(again.unmapped).toEqual(first.unmapped);
    expect(await mapsOf('location', ALL.location)).toEqual(before);
  });

  it('[S2-06] rejects an extract with a duplicate legacy ID', () => {
    const x = extract();
    x.features.push({ ...(x.features[0] as (typeof x.features)[number]) });
    expect(LegacyTaxonomyExtract.safeParse(x).success).toBe(false);
  });
});
