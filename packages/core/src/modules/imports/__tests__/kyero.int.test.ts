import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
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
import { kyeroConnector } from '../kyero/connector';

/**
 * A Kyero v3 feed through the whole run (S6-03): parse → map → validate → loader, with the real taxonomy resolver.
 * The fixture's taxonomy names get a per-run suffix so they cannot meet other tests' data.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'kyero-test', level: (process.env.TEST_LOG as 'warn' | undefined) ?? 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.kyero.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const tr = (name: string) => [
  { locale: 'en', name: `${name} ${RUN}`, slug: `${name.toLowerCase().replaceAll(/[^a-z]+/g, '-')}-${RUN}` },
];

const FIXTURE = fileURLToPath(new URL('../../../../../../tests/fixtures/kyero/feed.xml', import.meta.url));
const TAXONOMY_TAGS = 'type|town|province|country|location_detail|feature';
const feedXml = readFileSync(FIXTURE, 'utf8').replace(
  new RegExp(`<(${TAXONOMY_TAGS})>([^<]+)</\\1>`, 'g'),
  (whole, tag: string, value: string) =>
    ['Cortijo', 'Calahonda Alta', 'Padel court'].includes(value) ? whole : `<${tag}>${value} ${RUN}</${tag}>`,
);

let owner: Founder;
const undo: (() => void)[] = [];
const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' }, fn);

const loc: Record<string, string> = {};

beforeAll(async () => {
  await setupTestDb('worker');
  imports.configureImports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    withdrawAfterMissedRuns: 3,
  });
  owner = await createFounder();
  undo.push(
    imports.registerConnector({
      ...kyeroConnector,
      key: 'kyero-fixture',
      // The mapper adds the feature "Pool" itself (pool=1): give it the run suffix like the feed's own names.
      map: (raw, ctx) => {
        const r = kyeroConnector.map(raw, ctx);
        if (r.ok) r.item = { ...r.item, features: r.item.features?.map((f) => (f === 'Pool' ? `Pool ${RUN}` : f)) };
        return r;
      },
      fetch: async () => ({
        body: Readable.from([Buffer.from(feedXml)]),
        bytesRead: () => feedXml.length,
        contentType: 'application/xml',
      }),
    }),
  );
  await system(async (tx) => {
    const spain = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `ky-c-${RUN}`,
      translations: tr('Spain'),
    });
    const malaga = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: spain,
      code: `ky-r-${RUN}`,
      translations: tr('Málaga'),
    });
    loc.country = spain;
    loc.region = malaga;
    for (const [key, name] of [
      ['marbella', 'Marbella'],
      ['estepona', 'Estepona'],
      ['fuengirola', 'Fuengirola'],
      ['mijas', 'Mijas'],
    ] as const) {
      loc[key] = await taxonomy.createLocation(tx, {
        level: 'CITY',
        parentId: malaga,
        code: `ky-${key}-${RUN}`,
        translations: tr(name),
      });
    }
    loc.nueva = await taxonomy.createLocation(tx, {
      level: 'AREA',
      parentId: loc.marbella as string,
      code: `ky-na-${RUN}`,
      translations: tr('Nueva Andalucía'),
    });
    const typeGroup = await taxonomy.createPropertyTypeGroup(tx, {
      key: `ky-types-${RUN}`,
      sort: 0,
      translations: tr('Kyero Types'),
    });
    for (const name of ['Villa', 'Apartment', 'Penthouse', 'Townhouse']) {
      loc[`type${name}`] = await taxonomy.createPropertyType(tx, {
        groupId: typeGroup,
        key: `ky-${name.toLowerCase()}-${RUN}`,
        sort: 0,
        translations: tr(name),
      });
    }
    const featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: `ky-features-${RUN}`,
      sort: 0,
      translations: tr('Kyero Features'),
    });
    let sort = 0;
    for (const name of ['Pool', 'Air conditioning', 'Sea views', 'Garden', 'Garage']) {
      await taxonomy.createFeature(tx, {
        groupId: featureGroup,
        key: `ky-${name.toLowerCase().replaceAll(' ', '-')}-${RUN}`,
        sort: sort++,
        icon: 'star',
        translations: tr(name),
      });
    }
  });
}, 120_000);

afterAll(async () => {
  for (const u of undo) u();
  await closeDb();
});

describe('Kyero v3 feed run', () => {
  it('[S6-03] the fixture feed imports: valid items become listings with taxonomy resolved per level, refused items are reported', async () => {
    const c = await as((ctx) =>
      imports.createFeedConnection(
        ctx,
        CreateFeedConnectionBody.parse({
          name: 'Kyero fixture',
          connector: 'kyero-fixture',
          url: 'https://feeds.example.test/kyero.xml',
          scheduleMinutes: null,
          settings: { defaultCountry: `Spain ${RUN}` },
        }),
      ),
    );
    const run = await as((ctx) => imports.requestFeedRun(ctx, c.id));
    const outcome = await imports.executeRun({ runId: run.id, agencyId: owner.agencyId }, job());
    expect(outcome).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    const dto = await as((ctx) => imports.getFeedRun(ctx, run.id));
    // 9 records: 5 valid (one held as a draft for an unmatched area and feature), 4 refused (three bad, one with an
    // unmatched property type, which keeps a new listing out until staff map it).
    expect(dto.counts).toMatchObject({ total: 9, valid: 5, failed: 4, created: 5, held: 1 });
    const errors = await as((ctx) => imports.listFeedItemErrors(ctx, run.id, { limit: 10 }));
    expect(errors.items.map((e) => [e.itemRef, e.code, e.field])).toEqual([
      ['K-1006', 'MISSING_FIELD', 'type'],
      ['K-1007', 'INVALID_PRICE', 'price'],
      [null, 'MISSING_FIELD', 'id'],
      ['K-1009', 'PROPERTY_TYPE_UNMATCHED', 'propertyType'],
    ]);

    type Row = {
      ref: string;
      status: string;
      transaction_type: string;
      price_cents: string | null;
      location_id: string;
      property_type_id: string | null;
      held: string[] | null;
      features: string;
      locales: string;
    };
    const stored = new Map(
      (
        await rows<Row>(sql`
          select pp.external_ref as ref, p.status, p.transaction_type, p.price_cents, p.location_id, p.property_type_id,
                 pp.import_held as held,
                 (select count(*)::text from property_features f where f.property_id = p.id) as features,
                 (select string_agg(t.locale, ',' order by t.locale) from property_translations t where t.property_id = p.id) as locales
            from properties p join property_privates pp on pp.property_id = p.id
           where p.agency_id = ${owner.agencyId} and pp.import_connection_id = ${c.id}`)
      ).map((r) => [r.ref, r]),
    );
    expect([...stored.keys()].sort()).toEqual(['K-1001', 'K-1002', 'K-1003', 'K-1004', 'K-1005']);
    expect(stored.get('K-1001')).toMatchObject({
      status: 'ACTIVE',
      transaction_type: 'SALE',
      price_cents: '125000000',
      location_id: loc.nueva,
      property_type_id: loc.typeVilla,
      held: null,
      features: '5',
      locales: 'de,en,es',
    });
    expect(stored.get('K-1002')).toMatchObject({
      transaction_type: 'RENT_LONG_TERM',
      location_id: loc.estepona,
      locales: 'en,es,fr,nl',
    });
    expect(stored.get('K-1003')).toMatchObject({ transaction_type: 'RENT_SHORT_TERM', location_id: loc.marbella });
    expect(stored.get('K-1004')).toMatchObject({ price_cents: null, location_id: loc.fuengirola });
    // Unmatched type, area and feature hold the listing as a draft and wait for staff.
    const held = stored.get('K-1005') as Row;
    expect(held.status).toBe('DRAFT');
    expect([...(held.held ?? [])].sort()).toEqual(['feature', 'location']);
    const queued = await rows<{ kind: string; value_key: string }>(
      sql`select kind, value_key from taxonomy_unmatched where value_key in (${taxonomy.aliasKey('Cortijo')}, ${taxonomy.aliasKey('Calahonda Alta')}, ${taxonomy.aliasKey('Padel court')})`,
    );
    expect(queued.map((q) => q.kind).sort()).toEqual(['feature', 'location', 'propertyType']);

    // The stored description is plain text.
    const [text] = await rows<{ description: string }>(sql`
      select t.description from property_translations t join property_privates pp on pp.property_id = t.property_id
       where pp.import_connection_id = ${c.id} and pp.external_ref = 'K-1005' and t.locale = 'en'`);
    expect(text?.description).not.toMatch(/[<>]/);
    expect(text?.description).toContain('Restored country house.');
  }, 120_000);
  it('[S6-03] a Kyero connection can be created with a query credential kept encrypted (the URL stays free of the key)', async () => {
    const c = await as((ctx) =>
      imports.createFeedConnection(
        ctx,
        CreateFeedConnectionBody.parse({
          name: 'Kyero keyed',
          connector: 'kyero',
          url: 'https://feeds.example.test/kyero.xml?lang=en',
          credentials: { type: 'query', name: 'api_key', value: 'secret-value' },
          settings: { defaultCountry: 'Spain' },
          scheduleMinutes: null,
        }),
      ),
    );
    expect(c).toMatchObject({
      connector: 'kyero',
      hasCredentials: true,
      url: 'https://feeds.example.test/kyero.xml?lang=en',
    });
    expect(JSON.stringify(c)).not.toContain('secret-value');
    const [stored] = await rows<{ credentials_enc: string; url: string }>(
      sql`select credentials_enc, url from feed_connections where id = ${c.id}`,
    );
    expect(stored?.credentials_enc).not.toContain('secret-value');
    expect(stored?.url).not.toContain('secret-value');
  });
});
