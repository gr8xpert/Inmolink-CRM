import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as migration from '../index';
import { migrationJobs } from '../jobs';

/** Legacy → v2 delta sync (S14-04) from fixture legacy snapshots (the legacy database is H1). */

const RUN = newId().slice(-8).toLowerCase();
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const lid = (p: string, n: number | string) => `${RUN}-${p}-${n}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('migration.delta.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const requestMedia = async () => {};

const T0 = new Date('2026-10-01T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

type Row = Record<string, unknown> & { id: string; updated_at: string };
type Legacy = Record<migration.LegacyStagingEntity, Row[]>;

/** A legacy agency's rows (every id under prefix `p`), each with its legacy `updated_at`. */
function legacy(p: string): Legacy {
  const stamp = at(-60).toISOString();
  const listing = (n: number) => ({
    id: lid(p, `l${n}`),
    ref: code(`${p}R${n}`),
    agent_id: lid(p, 'u1'),
    status: 'available',
    listing_type: 'sale',
    price: 200_000 + n,
    bedrooms: 2,
    location_id: lid('tax', 'loc'),
    property_type_id: lid('tax', 'type'),
    translations: [{ locale: 'en', title: `Flat ${n}`, description: 'Near the beach' }],
    updated_at: stamp,
  });
  return {
    users: [
      { id: lid(p, 'u1'), email: `delta-${RUN}-${p}@example.com`, name: 'Agent', role: 'agent', updated_at: stamp },
    ],
    listings: Array.from({ length: 12 }, (_, i) => listing(i + 1)),
    developments: [],
    units: [],
    contacts: [{ id: lid(p, 'c1'), first_name: 'Ana', email: `ana-${RUN}-${p}@example.com`, updated_at: stamp }],
    leads: [],
  };
}

/** A fixture snapshot of `db` taken at `snapshotAt`; records the `since` each entity was asked for. */
function snapshot(db: Legacy, snapshotAt: Date) {
  const asked: Partial<Record<migration.LegacyStagingEntity, Date | null>> = {};
  const source: migration.LegacyDeltaSource = {
    snapshotAt,
    changed(entity, since) {
      asked[entity] = since;
      const picked = db[entity].filter((r) => !since || new Date(r.updated_at) > since);
      return migration.fromRows(picked.map(({ updated_at: _u, ...r }) => r));
    },
    async *listingIds() {
      yield db.listings.map((l) => l.id);
    },
  };
  return { source, asked };
}

async function loaded(p: string): Promise<{ founder: Founder; db: Legacy; legacyAgencyId: string }> {
  const founder = await createFounder();
  const db = legacy(p);
  const legacyAgencyId = lid(p, 'agency');
  await system((tx) => migration.resolveLegacyAgency(tx, legacyAgencyId, founder.agencyId));
  const result = await migration.migrateLegacyAgency({
    legacyAgencyId,
    agencyId: founder.agencyId,
    staged: Object.fromEntries(Object.entries(db).map(([k, r]) => [k, migration.fromRows(r)])),
    requestMedia,
  });
  expect(result.stoppedAt).toBeNull();
  return { founder, db, legacyAgencyId };
}

const sync = (l: Awaited<ReturnType<typeof loaded>>, snap: ReturnType<typeof snapshot>) =>
  migration.syncLegacyDelta({
    legacyAgencyId: l.legacyAgencyId,
    agencyId: l.founder.agencyId,
    source: snap.source,
    requestMedia,
  });

const listing = async (agencyId: string, legacyId: string) =>
  (
    await rows<{ id: string; status: string; price: number; deleted: boolean }>(
      sql`select id, status, price_cents::float8 / 100 as price, deleted_at is not null as deleted from properties
           where agency_id = ${agencyId} and legacy_id = ${legacyId}`,
    )
  )[0];

beforeAll(async () => {
  await setupTestDb('worker');
  await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('dl'),
      translations: tr(`Deltaland ${RUN}`, 'deltaland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('dl-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'dl-g'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('dl-flat'),
      sort: 0,
      translations: tr(`Flat ${RUN}`, 'dl-flat'),
    });
    await migration.recordMaps(tx, 'location', [[lid('tax', 'loc'), location]]);
    await migration.recordMaps(tx, 'propertyType', [[lid('tax', 'type'), type]]);
  });
}, 120_000);

afterAll(async () => {
  await system((tx) =>
    tx.execute(sql`update outbox_events set processed_at = now()
      where processed_at is null and created_at > now() - interval '1 hour' and type like any(array[
        'properties.%', 'crm.%', 'identity.member.named', 'media.feedImages.%'])`),
  );
  await closeDb();
});

describe('legacy delta sync (S14-04)', () => {
  it('[S14-04] a change in legacy appears in v2 after the next hourly delta (within 70 minutes)', async () => {
    const l = await loaded('a');
    // The schedule: one tick an hour, each run bounded well inside the next tick.
    expect(migration.DELTA.INTERVAL_MS).toBeLessThanOrEqual(60 * 60_000);
    expect(migrationJobs.scheduleLegacyDeltas.spec.every).toBe(migration.DELTA.INTERVAL_MS);
    expect(migration.DELTA.INTERVAL_MS + migrationJobs.syncLegacyDelta.timeoutMs).toBeLessThan(
      2 * migration.DELTA.INTERVAL_MS,
    );

    // First delta (no watermark yet): everything is read; nothing changed, nothing is written again.
    const first = snapshot(l.db, at(5));
    const r1 = await sync(l, first);
    expect(r1.skipped).toBeNull();
    expect(first.asked.listings).toBeNull();
    expect(r1.load?.report.counts.listing).toMatchObject({ staged: 12, unchanged: 12, created: 0, updated: 0 });
    expect(r1.watermark).toEqual(at(5));
    expect((await migration.legacyDeltaState(l.legacyAgencyId)).watermark).toEqual(at(5));

    // An agent changes a price in legacy at +30; a new listing appears at +40.
    const changed = l.db.listings[0] as Row;
    Object.assign(changed, { price: 199_000, updated_at: at(30).toISOString() });
    l.db.listings.push({
      ...(l.db.listings[1] as Row),
      id: lid('a', 'l13'),
      ref: code('aR13'),
      updated_at: at(40).toISOString(),
    });
    const second = snapshot(l.db, at(65));
    const r2 = await sync(l, second);
    // Read from the watermark minus the overlap; developments and units always whole.
    expect(second.asked.listings).toEqual(new Date(at(5).getTime() - migration.DELTA.OVERLAP_MS));
    expect(second.asked.developments).toBeNull();
    expect(r2.load?.report.counts.listing).toMatchObject({ staged: 2, updated: 1, created: 1 });
    expect((await listing(l.founder.agencyId, changed.id))?.price).toBe(199_000);
    expect(await listing(l.founder.agencyId, lid('a', 'l13'))).toMatchObject({ status: 'ACTIVE' });
    expect(r2.watermark).toEqual(at(65));

    // Delta checkpoints never replace the full load's.
    const keys = await rows<{ entity: string }>(
      sql`select distinct entity from migration_batches where legacy_agency_id = ${l.legacyAgencyId} order by 1`,
    );
    expect(keys.map((k) => k.entity)).toEqual(
      expect.arrayContaining(['contacts', 'delta:properties', 'delta:state', 'properties', 'users']),
    );
  });

  it('[S14-04] a row deleted in legacy withdraws its listing (never deleted); a returning row re-lists it', async () => {
    const l = await loaded('b');
    const gone = l.db.listings.shift() as Row;
    const r = await sync(l, snapshot(l.db, at(5)));
    expect(r.withdrawn).toBe(1);
    expect(r.withdrawGuard).toBeNull();
    expect(await listing(l.founder.agencyId, gone.id)).toMatchObject({ status: 'WITHDRAWN', deleted: false });
    const history = await rows<{ to: string }>(
      sql`select h.to_status as to from property_status_histories h join properties p on p.id = h.property_id
           where p.agency_id = ${l.founder.agencyId} and p.legacy_id = ${gone.id} order by h.changed_at desc, h.id desc limit 1`,
    );
    expect(history[0]?.to).toBe('WITHDRAWN');

    // The row is back in legacy (touched at +70): the next delta re-lists the listing.
    l.db.listings.push({ ...gone, updated_at: at(70).toISOString() });
    const again = await sync(l, snapshot(l.db, at(75)));
    expect(again.withdrawn).toBe(0);
    expect(await listing(l.founder.agencyId, gone.id)).toMatchObject({ status: 'ACTIVE' });
  });

  it('[S14-04] a legacy read that lacks most listings withdraws nothing (guard)', async () => {
    const l = await loaded('c');
    l.db.listings.splice(0, 11); // 11 of 12 gone: a broken read, not a real deletion
    const r = await sync(l, snapshot(l.db, at(5)));
    expect(r.withdrawn).toBe(0);
    expect(r.withdrawGuard).toEqual({ missing: 11, migrated: 12 });
    const live = await rows<{ n: number }>(
      sql`select count(*)::int as n from properties where agency_id = ${l.founder.agencyId} and status = 'ACTIVE'`,
    );
    expect(live[0]?.n).toBe(12);
  });

  it('[S14-04] v2 edits are not overwritten: agent-locked fields and migrated contacts keep their v2 values', async () => {
    const l = await loaded('d');
    const first = l.db.listings[0] as Row;
    const v2 = await listing(l.founder.agencyId, first.id);
    await system((tx) =>
      tx.execute(sql`update properties set price_cents = 18000000, locked_fields = array['price']
                      where id = ${v2?.id as string}`),
    );
    await system((tx) =>
      tx.execute(sql`update contacts set first_name = 'Ana María'
                      where agency_id = ${l.founder.agencyId} and first_name = 'Ana'`),
    );
    Object.assign(first, { price: 210_000, bedrooms: 3, updated_at: at(30).toISOString() });
    Object.assign(l.db.contacts[0] as Row, { first_name: 'Anita', updated_at: at(30).toISOString() });
    const r = await sync(l, snapshot(l.db, at(35)));
    expect(r.load?.stoppedAt).toBeNull();
    expect((await listing(l.founder.agencyId, first.id))?.price).toBe(180_000); // locked by the agent
    const beds = await rows<{ bedrooms: number }>(sql`select bedrooms from properties where id = ${v2?.id as string}`);
    expect(beds[0]?.bedrooms).toBe(3); // unlocked fields follow legacy
    const names = await rows<{ first_name: string }>(
      sql`select first_name from contacts where agency_id = ${l.founder.agencyId}`,
    );
    expect(names.map((n) => n.first_name)).toEqual(['Ana María']);
  });

  it('[S14-04] a cut-over agency gets no delta (agents work in v2); reopening resumes it', async () => {
    const l = await loaded('e');
    await migration.markLegacyAgencyCutOver({
      legacyAgencyId: l.legacyAgencyId,
      agencyId: l.founder.agencyId,
      cutOver: true,
    });
    const first = l.db.listings[0] as Row;
    Object.assign(first, { price: 99_000, updated_at: at(30).toISOString() });
    l.db.listings.pop();
    const r = await sync(l, snapshot(l.db, at(35)));
    expect(r).toMatchObject({ skipped: 'CUT_OVER', load: null, withdrawn: 0 });
    expect((await listing(l.founder.agencyId, first.id))?.price).toBe(200_001);
    const due = [];
    for await (const page of migration.deltaAgencies()) due.push(...page.map((a) => a.legacyAgencyId));
    expect(due).not.toContain(l.legacyAgencyId);

    await migration.markLegacyAgencyCutOver({
      legacyAgencyId: l.legacyAgencyId,
      agencyId: l.founder.agencyId,
      cutOver: false,
    });
    const again = await sync(l, snapshot(l.db, at(40)));
    expect(again.skipped).toBeNull();
    expect((await listing(l.founder.agencyId, first.id))?.price).toBe(99_000);
    const dueAgain = [];
    for await (const page of migration.deltaAgencies()) dueAgain.push(...page.map((a) => a.legacyAgencyId));
    expect(dueAgain).toContain(l.legacyAgencyId);
  });

  it('[S14-04] the hourly job queues nothing until a legacy reader is registered (H1)', async () => {
    migration.registerLegacyDeltaSource(null);
    const log = { info: () => {}, warn: () => {}, error: () => {} } as never;
    const ctx = { log, signal: new AbortController().signal, attempt: 1 } as never;
    await expect(migrationJobs.scheduleLegacyDeltas.spec.run({}, ctx)).resolves.toEqual({
      queued: 0,
      skipped: 'NO_SOURCE',
    });
    await expect(
      migrationJobs.syncLegacyDelta.spec.run({ legacyAgencyId: 'x', agencyId: newId(), slot: 1 }, ctx),
    ).resolves.toEqual({ skipped: 'NO_SOURCE' });
  });

  it('[S14-04] the job runs a delta through the registered reader and closes it', async () => {
    const l = await loaded('f');
    const first = l.db.listings[0] as Row;
    Object.assign(first, { price: 150_000, updated_at: at(30).toISOString() });
    let closed = 0;
    migration.registerLegacyDeltaSource(async () => ({
      ...snapshot(l.db, at(35)).source,
      close: async () => {
        closed += 1;
      },
    }));
    try {
      const log = { info: () => {}, warn: () => {}, error: () => {} } as never;
      const ctx = { log, signal: new AbortController().signal, attempt: 1 } as never;
      const out = await migrationJobs.syncLegacyDelta.spec.run(
        { legacyAgencyId: l.legacyAgencyId, agencyId: l.founder.agencyId, slot: 1 },
        ctx,
      );
      expect(out).toMatchObject({ skipped: null, stopped: false });
      expect(closed).toBe(1);
      expect((await listing(l.founder.agencyId, first.id))?.price).toBe(150_000);
    } finally {
      migration.registerLegacyDeltaSource(null);
    }
  });
  it('[S15-F4] with a legacy URL configured the hourly job queues one delta per non-cut-over agency', async () => {
    const open = await loaded('g');
    const done = await loaded('h');
    await migration.markLegacyAgencyCutOver({
      legacyAgencyId: done.legacyAgencyId,
      agencyId: done.founder.agencyId,
      cutOver: true,
    });
    expect(migration.configureLegacyDelta({ url: undefined })).toBe(false);
    expect(migration.legacyDeltaSourceFactory()).toBeNull();
    // The URL is only used when a delta runs; the schedule needs a registered reader.
    expect(migration.configureLegacyDelta({ url: 'postgres://legacy.invalid:5432/legacy' })).toBe(true);
    try {
      const due: string[] = [];
      for await (const page of migration.deltaAgencies()) due.push(...page.map((a) => a.legacyAgencyId));
      expect(due).toContain(open.legacyAgencyId);
      expect(due).not.toContain(done.legacyAgencyId);
      const log = { info: () => {}, warn: () => {}, error: () => {} } as never;
      const ctx = { log, signal: new AbortController().signal, attempt: 1 } as never;
      const out = (await migrationJobs.scheduleLegacyDeltas.spec.run({}, ctx)) as { queued: number };
      expect(out.queued).toBe(due.length);
    } finally {
      migration.registerLegacyDeltaSource(null);
    }
  });
});
