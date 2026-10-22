import { CreateFeedConnectionBody, resalesConnectionInput } from '@inmolink/contracts';
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
import * as developments from '../../developments';
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
  /** Details without fees, IBI and basura. */
  noFees: false,
  /** The price of unit A-1 in R2's price list. */
  a1Price: '500000',
  /** Listings besides R2 that are developments (one new unit each). */
  developmentRefs: new Set<string>(),
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
        Property: {
          Reference: ref,
          GpsX: '-4.9600',
          GpsY: '36.4900',
          BuiltYear: '2015',
          EnergyRating: 'C',
          ...(world.noFees ? {} : { Community_Fees_Year: '3,912', IBI_Fees_Year: '2,100', Basura_Tax_Year: '310' }),
          ...(world.developmentRefs.has(ref)
            ? {
                PropertyType: { NameType: 'New Development', Type: 'House', Subtype1: 'Detached Villa' },
                NewDevName: `Development ${ref}`,
                KeyReady: '0',
                PriceList: [{ Name: 'Z-1', Type: 'Detached Villa', Price: '400000', StatusCode: 'Available' }],
              }
            : {}),
          ...(ref === 'R2'
            ? {
                Price: '500,000 - 650,000',
                PropertyType: { NameType: 'New Development', Type: 'House', Subtype1: 'Detached Villa' },
                NewDevName: 'Seaside Residences',
                KeyReady: '0',
                PriceList: [
                  {
                    Name: 'A-1',
                    Type: 'Detached Villa',
                    Price: world.a1Price,
                    BuiltSize: '120',
                    Beds: '3',
                    Baths: '2',
                    StatusCode: 'Available',
                  },
                  {
                    Name: 'B-4',
                    Type: 'Detached Villa',
                    Price: null,
                    BuiltSize: '150',
                    Beds: '4',
                    Baths: '3',
                    StatusCode: 'Sold',
                  },
                ],
              }
            : {}),
        },
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
let registered: Parameters<typeof imports.registerConnector>[0];
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
  community_fee_month_cents: string | null;
  ibi_year_cents: string | null;
  garbage_tax_year_cents: string | null;
  price_to_cents: string | null;
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
    select pp.external_ref as ref, p.price_cents, p.community_fee_month_cents, p.ibi_year_cents,
           p.garbage_tax_year_cents, p.price_to_cents, p.lat, p.year_built, p.energy_rating,
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
  registered = {
    ...connector,
    // The taxonomy text gets the run suffix, like the names created below.
    map: (raw: Parameters<typeof connector.map>[0], ctx: Parameters<typeof connector.map>[1]) => {
      const r = connector.map(raw, ctx);
      if (!r.ok) return r;
      const l = r.item.location ?? {};
      return {
        ...r,
        item: {
          ...r.item,
          propertyType: sfx(r.item.propertyType),
          features: [],
          ...(r.item.development
            ? {
                development: {
                  ...r.item.development,
                  units: r.item.development.units.map((u) => ({ ...u, type: u.type ? sfx(u.type) : null })),
                },
              }
            : {}),
          location: {
            ...(l.country ? { country: sfx(l.country) } : {}),
            ...(l.region ? { region: sfx(l.region) } : {}),
            ...(l.city ? { city: sfx(l.city) } : {}),
          },
        },
      };
    },
  };
  undo = imports.registerConnector(registered);
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

  it('[S7-F14] a details record with fees, IBI and basura stores them on the listing, and the range end', async () => {
    const s = await stored();
    // 3,912 a year = 326.00 a month
    expect(s.get('R1')).toMatchObject({
      community_fee_month_cents: '32600',
      ibi_year_cents: '210000',
      garbage_tax_year_cents: '31000',
      price_to_cents: null,
    });
    expect(s.get('R2')).toMatchObject({ price_cents: '50000000', price_to_cents: '65000000' });
  });

  type Dev = {
    id: string;
    ref: string;
    name: string;
    status: string;
    version: number;
    updated_at: string;
    commission_bp: number | null;
    commission_fixed_cents: string | null;
    access: string;
    access_rows: number;
  };
  const developmentsOf = () =>
    rows<Dev>(sql`select d.id, d.ref, d.name, d.status, d.version, d.updated_at::text, d.commission_bp, d.commission_fixed_cents,
                          d.access, (select count(*)::int from development_access a where a.development_id = d.id) as access_rows
                     from developments d
                    where d.agency_id = ${owner.agencyId} and d.deleted_at is null and d.ref like 'RO-%' order by d.ref`);
  const unitsOf = () =>
    rows<{
      ref: string;
      status: string;
      price_cents: string | null;
      version: number;
      commission_bp: number | null;
      commission_fixed_cents: string | null;
    }>(sql`
      select u.ref, u.status, u.price_cents, u.version, u.commission_bp, u.commission_fixed_cents
        from units u join developments d on d.id = u.development_id
       where d.agency_id = ${owner.agencyId} and d.ref = 'RO-R2' order by u.ref`);

  it('[S7-F14] a development with a 2-unit price list creates one development with 2 units, and a re-run changes nothing', async () => {
    const devs = await developmentsOf();
    expect(devs).toHaveLength(1);
    expect(devs[0]).toMatchObject({
      ref: 'RO-R2',
      name: 'Seaside Residences',
      status: 'OFF_PLAN',
      // Nothing of the agency's deal or sharing reaches a public path: private to the agency, no commission.
      access: 'PRIVATE_NETWORK',
      access_rows: 0,
      commission_bp: null,
      commission_fixed_cents: null,
    });
    const us = await unitsOf();
    expect(us.map((u) => [u.ref, u.status, u.price_cents])).toEqual([
      ['A-1', 'AVAILABLE', '50000000'],
      ['B-4', 'SOLD', null],
    ]);
    expect(us.every((u) => u.commission_bp === null && u.commission_fixed_cents === null)).toBe(true);
    // Forget the source hashes so the next run reads the details again and imports the development once more.
    await system((tx) => tx.execute(sql`delete from feed_source_hashes where agency_id = ${owner.agencyId}`));
    const r = await runOnce();
    expect(r.outcome).toMatchObject({ state: 'SUCCEEDED' });
    expect(calls.some((u) => u.searchParams.get('P_RefId') === 'R2')).toBe(true);
    expect(await developmentsOf()).toEqual(devs);
    expect(await unitsOf()).toEqual(us);
  });

  it('[S7-F14] a changed price list updates only the changed unit, in one statement for any number', async () => {
    const before = await unitsOf();
    world.a1Price = '520000';
    await system((tx) => tx.execute(sql`delete from feed_source_hashes where agency_id = ${owner.agencyId}`));
    expect((await runOnce()).outcome).toMatchObject({ state: 'SUCCEEDED' });
    const after = await unitsOf();
    expect(after.map((u) => [u.ref, u.price_cents, u.version])).toEqual([
      ['A-1', '52000000', (before[0]?.version ?? 0) + 1],
      ['B-4', null, before[1]?.version],
    ]);
    const history = await rows<{ n: number }>(sql`
      select count(*)::int as n from unit_price_histories h join units u on u.id = h.unit_id
       where u.agency_id = ${owner.agencyId} and u.ref = 'A-1' and h.price_cents = 52000000`);
    expect(history[0]?.n).toBe(1);
  });

  it('[S7-F14] fees a connector no longer sends are cleared; a connector that never sends them keeps the stored ones', async () => {
    const reread = async () => {
      await system((tx) => tx.execute(sql`delete from feed_source_hashes where agency_id = ${owner.agencyId}`));
      expect((await runOnce()).outcome).toMatchObject({ state: 'SUCCEEDED' });
      return (await stored()).get('R1');
    };
    // A connector that never sends costs: a read without them keeps the stored ones.
    world.noFees = true;
    registered.sendsCosts = false;
    expect(await reread()).toMatchObject({ community_fee_month_cents: '32600', ibi_year_cents: '210000' });
    // Resales sends them whenever the listing has them: put them back, then take them away.
    world.noFees = false;
    registered.sendsCosts = true;
    expect(await reread()).toMatchObject({ community_fee_month_cents: '32600', ibi_year_cents: '210000' });
    world.noFees = true;
    expect(await reread()).toMatchObject({
      community_fee_month_cents: null,
      ibi_year_cents: null,
      garbage_tax_year_cents: null,
    });
    world.noFees = false;
  });

  it('[S7-F14] a development that cannot be stored is reported as DEVELOPMENT_SKIPPED with its error code; the listing still imports', async () => {
    const [type] = await rows<{ id: string }>(sql`select id from property_types where key = ${`rs-villa-${RUN}`}`);
    const [place] = await rows<{ id: string }>(
      sql`select location_id as id from properties where agency_id = ${owner.agencyId} limit 1`,
    );
    // A development of the agency under the feed's reference that is already full (2,000 units): one more is refused.
    const made = await as((ctx) =>
      developments.createDevelopment(ctx, { ref: 'RO-R4', name: 'Full', locationId: place?.id as string }),
    );
    for (let i = 0; i < 4; i++) {
      await as((ctx) =>
        developments.createUnits(ctx, made.id, {
          units: Array.from({ length: 500 }, (_, j) => ({
            ref: `U-${i * 500 + j}`,
            propertyTypeId: type?.id as string,
          })),
        }),
      );
    }
    world.refs.push('R4');
    world.price.R4 = '300,000';
    world.developmentRefs.add('R4');
    await system((tx) => tx.execute(sql`delete from feed_source_hashes where agency_id = ${owner.agencyId}`));
    const r = await runOnce();
    const [last] = await rows<{ error_code: string | null; error_detail: string | null }>(
      sql`select error_code, error_detail from feed_runs where agency_id = ${owner.agencyId} order by created_at desc limit 1`,
    );
    expect(last).toEqual({ error_code: null, error_detail: null });
    expect(r.outcome).toMatchObject({ state: 'SUCCEEDED' });
    expect(r.errors).toEqual([['R4', 'DEVELOPMENT_SKIPPED']]);
    // A warning, not a failed item: the listing was stored.
    expect(r.counts).toMatchObject({ failed: 0, created: 1 });
    const detail = await rows<{ field: string; message: string }>(sql`
      select field, message from feed_item_errors where agency_id = ${owner.agencyId} and item_ref = 'R4' and code = 'DEVELOPMENT_SKIPPED'
       order by created_at desc limit 1`);
    expect(detail[0]).toEqual({ field: 'development', message: 'DEVELOPMENT_UNIT_LIMIT' });
    expect((await stored()).has('R4')).toBe(true);
    // The other development was not disturbed by the failed one (its own savepoint).
    expect((await developmentsOf()).map((d) => d.ref)).toEqual(['RO-R2', 'RO-R4']);
  });

  it('[S7-F14] the dashboard form creates a working Resales connection; a bad filter alias is FEED_SETTINGS_INVALID, another host FEED_URL_NOT_ALLOWED', async () => {
    // The body the form builds, from the shared builder (contracts): the fixed WebAPI address, Client ID and API key.
    const body = (filterAlias: string, url?: string) => {
      const input = resalesConnectionInput(
        { clientId: '1000', apiKey: 'b'.repeat(40), filterAlias, languages: 'es, de' },
        false,
      );
      if (!input.ok) throw new Error('expected a body');
      return CreateFeedConnectionBody.parse({
        name: 'Resales form',
        connector: 'resales-online',
        url: url ?? input.url,
        credentials: input.credentials,
        scheduleMinutes: 1440,
        settings: input.settings,
      });
    };
    const made = await as((ctx) => imports.createFeedConnection(ctx, body('3')));
    expect(made).toMatchObject({
      connector: 'resales-online',
      hasCredentials: true,
      settings: { filterAlias: '3', languages: 'es,de' },
    });
    await expect(as((ctx) => imports.createFeedConnection(ctx, body('54031')))).rejects.toMatchObject({
      code: 'FEED_SETTINGS_INVALID',
    });
    await expect(
      as((ctx) => imports.createFeedConnection(ctx, body('1', 'https://example.com/V6'))),
    ).rejects.toMatchObject({ code: 'FEED_URL_NOT_ALLOWED' });
    await as((ctx) => imports.deleteFeedConnection(ctx, made.id));
  });
});
