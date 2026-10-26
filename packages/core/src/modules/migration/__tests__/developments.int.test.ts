import type { LegacyLoadReport } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as migration from '../index';

/** Legacy new-build import (S4-04) on the real test database, from fixture staging rows (the real dump is H1). */

const RUN = newId().slice(-8).toLowerCase();
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
/** Legacy ids are global in `legacy_id_maps`: unique per run. */
const lid = (n: number | string) => `${RUN}-${n}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('migration.developments.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let owner: Founder;
let other: Founder;
let ids: { location: string; type: string };

const dev = (n: number, extra: object = {}) => ({
  id: lid(n),
  ref: code(`D${n}`),
  name: `Residencial ${n}`,
  status: 'off_plan',
  location_id: lid('loc'),
  translations: [{ locale: 'en', title: `Residencial ${n}`, description: 'Sea views' }],
  ...extra,
});
const unit = (n: number, devN: number, extra: object = {}) => ({
  id: lid(n),
  development_id: lid(devN),
  ref: `U${n}`,
  property_type_id: lid('type'),
  bedrooms: 2,
  built_m2: 85.5,
  price: 300_000 + n,
  status: 'available',
  ...extra,
});

function load(
  agency: Founder,
  staged: { developments: unknown[]; units: unknown[] },
  opts: { dryRun?: boolean; legacyRows?: { development?: number; unit?: number }; legacyAgencyId?: string } = {},
): Promise<LegacyLoadReport> {
  return system((tx) =>
    migration.loadLegacyDevelopments(
      tx,
      {
        legacyAgencyId: opts.legacyAgencyId ?? lid('agency'),
        agencyId: agency.agencyId,
        ...staged,
        legacyRows: opts.legacyRows,
      },
      { dryRun: opts.dryRun },
    ),
  );
}

const eventsOf = async (agencyId: string) =>
  (
    await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where agency_id = ${agencyId} and type like 'developments.%'`,
    )
  )[0]?.n ?? 0;
const mapsOf = (entity: string, legacyIds: string[]) =>
  rows<{ legacy_id: string; new_id: string }>(
    sql`select legacy_id, new_id from legacy_id_maps where entity = ${entity}
         and legacy_id = any(${sql.param(legacyIds)}::text[]) order by legacy_id`,
  );

beforeAll(async () => {
  await setupTestDb('worker');
  owner = await createFounder();
  other = await createFounder();
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('lg'),
      translations: tr(`Legacyland ${RUN}`, 'legacyland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('lg-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'lg-g'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('lg-flat'),
      sort: 0,
      translations: tr(`Flat ${RUN}`, 'lg-flat'),
    });
    // What `legacy:taxonomy` (S2-06) leaves behind for the legacy location and property type.
    await migration.recordMaps(tx, 'location', [[lid('loc'), location]]);
    await migration.recordMaps(tx, 'propertyType', [[lid('type'), type]]);
    return { location, type };
  });
}, 120_000);

afterAll(async () => {
  // Nobody here dispatches the events: settle them so they take no other suite's claims.
  await system((tx) =>
    tx.execute(
      sql`update outbox_events set processed_at = now()
           where agency_id in (${owner.agencyId}, ${other.agencyId}) and processed_at is null`,
    ),
  );
  await closeDb();
});

describe('legacy new-build import (S4-04)', () => {
  const staged = () => ({
    developments: [
      dev(1, {
        status: 'Key ready',
        completion_date: '2026-03-31',
        lat: 36.51,
        lng: -4.88,
        commission_percent: 3,
      }),
      dev(2),
    ],
    units: [unit(11, 1, { orientation: 'S', floor: 2 }), unit(12, 1, { status: 'sold' }), unit(21, 2)],
  });

  it('[S4-04] imports legacy projects into developments and units; counts match the inventory; ids mapped', async () => {
    const before = await eventsOf(owner.agencyId);
    const report = await load(owner, staged(), { legacyRows: { development: 2, unit: 3 } });
    expect(report.issues).toEqual([]);
    expect(report.counts.development).toMatchObject({ legacyRows: 2, staged: 2, created: 2, mapped: 2, matches: true });
    expect(report.counts.unit).toMatchObject({ legacyRows: 3, staged: 3, created: 3, mapped: 3, matches: true });
    expect(report.matches).toBe(true);

    const devMaps = await mapsOf('development', [lid(1), lid(2)]);
    expect(devMaps).toHaveLength(2);
    const [d1] = await rows<Record<string, unknown>>(
      sql`select ref, name, status, completion_date::text as completion, lat::float8 as lat, commission_bp, legacy_id,
                 access, from_feed, location_id
            from developments where id = ${devMaps[0]?.new_id}`,
    );
    expect(d1).toMatchObject({
      ref: code('D1'),
      name: 'Residencial 1',
      status: 'KEY_READY',
      completion: '2026-03-31',
      lat: 36.51,
      commission_bp: 300,
      legacy_id: lid(1),
      access: 'PRIVATE_NETWORK',
      from_feed: false,
      location_id: ids.location,
    });
    const texts = await rows<{ slug: string; description: string }>(
      sql`select slug, description from development_translations where development_id = ${devMaps[0]?.new_id}`,
    );
    expect(texts).toEqual([{ slug: 'residencial-1', description: 'Sea views' }]);

    const unitMaps = await mapsOf('unit', [lid(11), lid(12), lid(21)]);
    expect(unitMaps).toHaveLength(3);
    const units = await rows<Record<string, unknown>>(
      sql`select u.ref, u.price_cents::float8 as price, u.status, u.orientation, u.floor, u.internal_m2::float8 as m2,
                 u.property_type_id, u.development_id
            from units u where u.id = any(${sql.param(unitMaps.map((m) => m.new_id))}::uuid[]) order by u.ref`,
    );
    expect(units).toEqual([
      expect.objectContaining({
        ref: 'U11',
        price: 30_001_100,
        status: 'AVAILABLE',
        orientation: 'S',
        floor: 2,
        m2: 85.5,
      }),
      expect.objectContaining({ ref: 'U12', status: 'SOLD', property_type_id: ids.type }),
      expect.objectContaining({ ref: 'U21', development_id: devMaps[1]?.new_id }),
    ]);
    // 2 developments + 3 units created: their events reach search and read models through the outbox
    expect((await eventsOf(owner.agencyId)) - before).toBe(5);
  });

  it('[S4-04] is idempotent: a re-run changes nothing; a changed legacy row is updated in place', async () => {
    const versions = () =>
      rows<{ v: number }>(
        sql`select coalesce(sum(version), 0)::int as v from developments where agency_id = ${owner.agencyId}
             and legacy_id = any(${sql.param([lid(1), lid(2)])}::text[])`,
      );
    const v0 = await versions();
    const e0 = await eventsOf(owner.agencyId);
    const again = await load(owner, staged(), { legacyRows: { development: 2, unit: 3 } });
    expect(again.counts.development).toMatchObject({ created: 0, updated: 0, unchanged: 2, matches: true });
    expect(again.counts.unit).toMatchObject({ created: 0, updated: 0, unchanged: 3, matches: true });
    expect(await versions()).toEqual(v0);
    expect(await eventsOf(owner.agencyId)).toBe(e0);

    // The legacy project was renamed, a unit repriced and given a new reference (matched by its map), one unit added.
    const changed = staged();
    (changed.developments[1] as { name: string }).name = 'Residencial 2 bis';
    changed.units[0] = unit(11, 1, { orientation: 'S', floor: 2, price: 290_000, ref: 'U11-new' });
    changed.units.push(unit(13, 1));
    const third = await load(owner, changed);
    expect(third.counts.development).toMatchObject({ created: 0, updated: 1, unchanged: 1, matches: true });
    expect(third.counts.unit).toMatchObject({ created: 1, updated: 1, unchanged: 2, matches: true });
    const [u11] = await mapsOf('unit', [lid(11)]);
    const [row] = await rows<{ ref: string; price: number }>(
      sql`select ref, price_cents::float8 as price from units where id = ${u11?.new_id}`,
    );
    expect(row).toEqual({ ref: 'U11-new', price: 29_000_000 });
    const history = await rows<{ n: number }>(
      sql`select count(*)::int as n from unit_price_histories where unit_id = ${u11?.new_id}`,
    );
    expect(history[0]?.n).toBe(2); // created, then repriced
  });

  it('[S4-04] lists mismatches in the report: rows not loaded with a reason, counts against the inventory', async () => {
    // A development made by hand already holds the reference a legacy project would take.
    await system(async (tx) => {
      await tx.execute(sql`insert into developments (id, agency_id, ref, name, location_id)
        values (${newId()}, ${other.agencyId}, ${code('TAKEN')}, 'Hand made', ${ids.location})`);
    });
    const report = await load(
      other,
      {
        developments: [
          dev(31),
          dev(32, { location_id: lid('nowhere') }),
          dev(33, { ref: code('TAKEN') }),
          dev(34, { name: '' }),
        ],
        units: [unit(311, 31), unit(312, 31, { property_type_id: lid('castle') }), unit(321, 32), unit(331, 33)],
      },
      // the dump holds a project the extract did not stage
      { legacyRows: { development: 5, unit: 4 }, legacyAgencyId: lid('agency-2') },
    );
    expect(report.matches).toBe(false);
    expect(report.counts.development).toMatchObject({
      legacyRows: 5,
      staged: 4,
      created: 1,
      failed: 3,
      matches: false,
    });
    expect(report.counts.unit).toMatchObject({ legacyRows: 4, staged: 4, created: 1, failed: 3, matches: false });
    expect(report.issues.map((i) => `${i.entity}:${i.legacyId}:${i.reason}`).sort()).toEqual(
      [
        `development:${lid(32)}:unmapped_location`,
        `development:${lid(33)}:ref_taken`,
        `development:${lid(34)}:invalid`,
        `unit:${lid(312)}:unmapped_property_type`,
        `unit:${lid(321)}:orphan`,
        `unit:${lid(331)}:refused`,
      ].sort(),
    );
    // only what loaded is mapped
    expect((await mapsOf('development', [lid(31), lid(32), lid(33), lid(34)])).map((m) => m.legacy_id)).toEqual([
      lid(31),
    ]);
  });

  it('[S4-04] a dry run checks everything and writes nothing', async () => {
    const report = await load(owner, { developments: [dev(41)], units: [unit(411, 41)] }, { dryRun: true });
    expect(report).toMatchObject({ dryRun: true, matches: true });
    expect(report.counts.development).toMatchObject({ created: 1 });
    expect(await mapsOf('development', [lid(41)])).toEqual([]);
    expect(
      await rows(sql`select 1 from developments where agency_id = ${owner.agencyId} and legacy_id = ${lid(41)}`),
    ).toEqual([]);
  });

  it('[S4-04] a batch is a fixed number of statements, whatever its size', async () => {
    const batch = (from: number, n: number) => ({
      developments: Array.from({ length: n }, (_, i) => dev(from + i)),
      units: Array.from({ length: n }, (_, i) => unit((from + i) * 10, from + i)),
    });
    const count = (b: ReturnType<typeof batch>) => countQueries(() => load(owner, b, { dryRun: true }));
    const small = await count(batch(1000, 2));
    const big = await count(batch(2000, 60));
    expect(big).toBe(small);
    // maps ×3, lock, units, texts, 2 inserts, history, outbox, 2 map upserts (+ savepoint statements)
    expect(small).toBeGreaterThan(8);
    expect(small).toBeLessThanOrEqual(20);
  });

  it('[S15-F2] a batch with one bad row loads the rest in a bounded number of statements', async () => {
    const batch = (from: number, n: number, bad: Record<number, object> = {}) => ({
      developments: Array.from({ length: n }, (_, i) => dev(from + i, bad[i])),
      units: Array.from({ length: n }, (_, i) => unit((from + i) * 10, from + i)),
    });
    const good = await countQueries(() => load(owner, batch(3000, 40)));
    // the database refuses a NUL byte in text: the screen cannot see it, so the batch is bisected
    const report = await load(owner, batch(3100, 40, { 17: { name: 'bad\u0000name' } }));
    expect(report.counts.development).toMatchObject({ created: 39, failed: 1 });
    const bisected = await countQueries(() => load(owner, batch(3200, 40, { 5: { name: 'bad\u0000name' } })));
    // one failing path through log2(40) levels, not one retry per row (40 batches)
    expect(bisected).toBeLessThanOrEqual(good * 9);
    expect(bisected).toBeLessThan(good * 40);
    // a row the screen can see is refused with no failed statement at all
    const screened = await countQueries(() => load(owner, batch(3300, 40, { 5: { currency: 'EURO' } })));
    expect(screened).toBeLessThanOrEqual(good + 4);
  });

  it('[S4-04] the legacy agency is named once, then found in the maps; never moved silently', async () => {
    const legacyAgencyId = lid('agency-3');
    await expect(system((tx) => migration.resolveLegacyAgency(tx, legacyAgencyId))).rejects.toThrow(/no v2 agency/);
    await expect(system((tx) => migration.resolveLegacyAgency(tx, legacyAgencyId, newId()))).rejects.toThrow(
      /does not exist/,
    );
    expect(await system((tx) => migration.resolveLegacyAgency(tx, legacyAgencyId, owner.agencyId))).toBe(
      owner.agencyId,
    );
    expect(await system((tx) => migration.resolveLegacyAgency(tx, legacyAgencyId))).toBe(owner.agencyId);
    await expect(system((tx) => migration.resolveLegacyAgency(tx, legacyAgencyId, other.agencyId))).rejects.toThrow(
      /mapped to another agency/,
    );
  });

  it('[S4-04] a development deleted in v2 stays deleted; its units are reported', async () => {
    await load(owner, { developments: [dev(51)], units: [] });
    const [m] = await mapsOf('development', [lid(51)]);
    await system((tx) => tx.execute(sql`update developments set deleted_at = now() where id = ${m?.new_id}`));
    const report = await load(owner, { developments: [dev(51, { name: 'Renamed' })], units: [unit(511, 51)] });
    expect(report.counts.development).toMatchObject({ unchanged: 1, updated: 0 });
    expect(report.issues).toEqual([
      { entity: 'unit', legacyId: lid(511), reason: 'refused', detail: 'DEVELOPMENT_DELETED' },
    ]);
    const [row] = await rows<{ name: string }>(sql`select name from developments where id = ${m?.new_id}`);
    expect(row?.name).toBe('Residencial 51');
  });
});
