import { CreateFeedConnectionBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as imports from '../index';
import { createResalesConnector, type ResalesResponse } from '../resales/connector';

/**
 * The Resales Online connector through whole runs against the real loader (S6-F4): what a details or language
 * failure leaves stored, unchanged listings seen only (no extra calls, not withdrawn), and the source hashes' life.
 * The API is a fake (the key is IP-bound; H13): two own listings and one shared, details and Spanish per call.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'resales-int', level: (process.env.TEST_LOG as 'warn' | undefined) ?? 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.resales.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const sfx = (s: string) => `${s} rs ${RUN}`;
const tr = (name: string) => [
  { locale: 'en', name: sfx(name), slug: `${name.toLowerCase().replaceAll(/[^a-z]+/g, '-')}-rs-${RUN}` },
];

/** What the fake API answers; tests change it between runs. */
const world = {
  refs: ['R1', 'R2'],
  price: { R1: '1,000,000', R2: '500,000' } as Record<string, string>,
  failDetails: new Set<string>(),
  failSpanish: false,
};
const calls: URL[] = [];
const ok = (v: unknown): ResalesResponse => ({ status: 200, text: JSON.stringify(v) });

const connector = createResalesConnector(
  async ({ url }) => {
    const u = new URL(url);
    calls.push(u);
    const ref = u.searchParams.get('P_RefId');
    if (ref) {
      if (world.failDetails.has(ref)) return { status: 503, text: '' };
      return ok({
        transaction: { status: 'success' },
        Property: { Reference: ref, GpsX: '-4.9600', GpsY: '36.4900', BuiltYear: '2015', EnergyRating: 'C' },
      });
    }
    const lang = u.searchParams.get('P_Lang');
    if (lang === '2' && world.failSpanish) return { status: 500, text: '' };
    const own = world.refs.map((r) => ({
      Reference: r,
      OwnProperty: '1',
      Country: 'Spain',
      Province: 'Málaga',
      Location: 'Marbella',
      PropertyType: { NameType: 'Detached Villa' },
      Price: world.price[r],
      Description: lang === '2' ? `Villa preciosa ${r}.` : `Lovely villa ${r}.`,
    }));
    const shared = { Reference: 'S1', OwnProperty: '0', Location: 'Nerja', PropertyType: { NameType: 'Penthouse' } };
    return ok({
      transaction: { status: 'success' },
      QueryInfo: { PropertyCount: own.length + 1, PropertiesPerPage: 40, SearchType: 'Sale' },
      Property: [...own, shared],
    });
  },
  { key: 'resales-int', sleep: async () => {}, now: () => Date.now() },
);

let owner: Founder;
let undo: () => void;
let connectionId: string;
const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' }, fn);

async function runOnce() {
  calls.length = 0;
  const run = await as((ctx) => imports.requestFeedRun(ctx, connectionId));
  const outcome = await imports.executeRun({ runId: run.id, agencyId: owner.agencyId }, job());
  const dto = await as((ctx) => imports.getFeedRun(ctx, run.id));
  const errors = await as((ctx) => imports.listFeedItemErrors(ctx, run.id, { limit: 10 }));
  return { outcome, counts: dto.counts, errors: errors.items.map((e) => [e.itemRef, e.code]) };
}

type Stored = {
  ref: string;
  price_cents: string | null;
  lat: string | null;
  year_built: number | null;
  energy_rating: string | null;
  missed: number;
  withdrawn: boolean;
  es: string | null;
};
async function stored(): Promise<Map<string, Stored>> {
  const list = await rows<Stored>(sql`
    select pp.external_ref as ref, p.price_cents, p.lat, p.year_built, p.energy_rating,
           pp.import_missed_runs as missed, pp.import_withdrawn_at is not null as withdrawn,
           (select t.description from property_translations t where t.property_id = p.id and t.locale = 'es') as es
      from properties p join property_privates pp on pp.property_id = p.id
     where p.agency_id = ${owner.agencyId} and pp.import_connection_id = ${connectionId}`);
  return new Map(list.map((r) => [r.ref, r]));
}
const hashes = () =>
  rows<{ ref: string; last_run_id: string }>(sql`
    select external_ref as ref, last_run_id from feed_source_hashes
     where agency_id = ${owner.agencyId} and connection_id = ${connectionId} order by external_ref`);

beforeAll(async () => {
  await setupTestDb('worker');
  imports.configureImports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    withdrawAfterMissedRuns: 3,
  });
  owner = await createFounder();
  undo = imports.registerConnector({
    ...connector,
    // The taxonomy text gets the run suffix, like the names created below.
    map: (raw, ctx) => {
      const r = connector.map(raw, ctx);
      if (!r.ok) return r;
      const l = r.item.location ?? {};
      return {
        ...r,
        item: {
          ...r.item,
          propertyType: sfx(r.item.propertyType),
          features: [],
          location: {
            ...(l.country ? { country: sfx(l.country) } : {}),
            ...(l.region ? { region: sfx(l.region) } : {}),
            ...(l.city ? { city: sfx(l.city) } : {}),
          },
        },
      };
    },
  });
  await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `rs-c-${RUN}`,
      translations: tr('Spain'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: `rs-r-${RUN}`,
      translations: tr('Málaga'),
    });
    await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: `rs-m-${RUN}`,
      translations: tr('Marbella'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `rs-types-${RUN}`,
      sort: 0,
      translations: tr('Types'),
    });
    await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `rs-villa-${RUN}`,
      sort: 0,
      translations: tr('Detached Villa'),
    });
  });
  const c = await as((ctx) =>
    imports.createFeedConnection(
      ctx,
      CreateFeedConnectionBody.parse({
        name: 'Resales fixture',
        connector: 'resales-int',
        url: 'https://webapi.resales-online.com/V6',
        credentials: { type: 'basic', username: '1000', password: 'a'.repeat(40) },
        scheduleMinutes: null,
        settings: { filterAlias: '1', languages: 'es' },
      }),
    ),
  );
  connectionId = c.id;
}, 120_000);

afterAll(async () => {
  undo?.();
  await closeDb();
});

describe('Resales Online runs (S6-F4)', () => {
  it('[S6-F4] a bad filter alias is refused when the connection is saved', async () => {
    await expect(
      as((ctx) =>
        imports.createFeedConnection(
          ctx,
          CreateFeedConnectionBody.parse({
            name: 'Bad alias',
            connector: 'resales-int',
            url: 'https://webapi.resales-online.com/V6',
            settings: { filterAlias: '54031' },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'FEED_SETTINGS_INVALID' });
  });

  it('[S6-F4] the first run stores the own listings with details, Spanish and a source hash each; shared ones never', async () => {
    const r = await runOnce();
    expect(r.outcome).toMatchObject({ state: 'SUCCEEDED' });
    expect(r.counts).toMatchObject({ total: 2, valid: 2, failed: 0, created: 2 });
    const s = await stored();
    expect([...s.keys()].sort()).toEqual(['R1', 'R2']);
    expect(s.get('R1')).toMatchObject({
      price_cents: '100000000',
      year_built: 2015,
      energy_rating: 'C',
      es: 'Villa preciosa R1.',
    });
    expect(Number(s.get('R1')?.lat)).toBeCloseTo(36.49, 2);
    expect((await hashes()).map((h) => h.ref)).toEqual(['R1', 'R2']);
  });

  it('[S6-F4] an unchanged account is seen only: no details or language call, nothing rewritten, nothing withdrawn', async () => {
    const r = await runOnce();
    expect(r.outcome).toMatchObject({ state: 'SUCCEEDED' });
    expect(r.counts).toMatchObject({ total: 2, valid: 2, failed: 0, created: 0, updated: 0, withdrawn: 0 });
    expect(calls.map((u) => u.searchParams.get('P_RefId') ?? u.searchParams.get('P_Lang') ?? 'page')).toEqual(['page']);
    const s = await stored();
    expect(s.get('R1')).toMatchObject({ missed: 0, withdrawn: false, year_built: 2015 });
  });

  it('[S6-F4] a details failure keeps the stored listing as it is: coordinates, year, energy rating and price survive, nothing withdrawn', async () => {
    world.price.R1 = '1,100,000'; // changed in the list: needs its details
    world.failDetails.add('R1');
    const r = await runOnce();
    world.failDetails.clear();
    expect(r.outcome).toMatchObject({ state: 'SUCCEEDED' });
    expect(r.errors).toEqual([['R1', 'DETAILS_UNAVAILABLE']]);
    const s = await stored();
    expect(s.get('R1')).toMatchObject({
      price_cents: '100000000',
      year_built: 2015,
      energy_rating: 'C',
      missed: 0,
      withdrawn: false,
    });
    expect(Number(s.get('R1')?.lat)).toBeCloseTo(36.49, 2);
  });

  it('[S6-F4] a language failure keeps the stored translation; the next good run writes the change', async () => {
    world.failSpanish = true;
    const r = await runOnce();
    world.failSpanish = false;
    expect(r.errors).toEqual([['R1', 'TRANSLATIONS_UNAVAILABLE']]);
    let s = await stored();
    expect(s.get('R1')).toMatchObject({ es: 'Villa preciosa R1.', price_cents: '100000000', withdrawn: false });
    const good = await runOnce();
    expect(good.counts).toMatchObject({ updated: 1, failed: 0 });
    s = await stored();
    expect(s.get('R1')).toMatchObject({ price_cents: '110000000', es: 'Villa preciosa R1.' });
  });

  it('[S6-F4] a listing that leaves the feed loses its hash, so it is fetched in full when it comes back', async () => {
    world.refs = ['R2'];
    const gone = await runOnce();
    expect(gone.outcome).toMatchObject({ state: 'SUCCEEDED' });
    expect((await hashes()).map((h) => h.ref)).toEqual(['R2']);
    expect((await stored()).get('R1')).toMatchObject({ missed: 1, withdrawn: false });
    world.refs = ['R1', 'R2'];
    const back = await runOnce();
    expect(calls.filter((u) => u.searchParams.get('P_RefId')).map((u) => u.searchParams.get('P_RefId'))).toEqual([
      'R1',
    ]);
    expect(back.counts).toMatchObject({ failed: 0 });
    expect((await stored()).get('R1')).toMatchObject({ missed: 0 });
    expect((await hashes()).map((h) => h.ref)).toEqual(['R1', 'R2']);
  });
});
