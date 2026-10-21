import { createReadStream, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CreateFeedConnectionBody, type FeedListingInput } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { streamXmlRecords, type XmlElement } from '@inmolink/platform/xml';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import { formatSettings } from '../assemble';
import * as imports from '../index';
import { infocasaConnector } from '../infocasa/connector';
import { mapInfocasaPropiedad } from '../infocasa/mapping';
import { inmobaConnector } from '../inmoba/connector';
import { mapInmobaProperty } from '../inmoba/mapping';
import { milenioConnector } from '../milenio/connector';
import { mapMilenioInmueble } from '../milenio/mapping';
import { thinkspainConnector } from '../thinkspain/connector';
import { mapThinkSpainProperty } from '../thinkspain/mapping';

/**
 * Each S6-07 fixture feed through the whole run: parse -> map -> validate -> loader, with the real taxonomy
 * resolver. The taxonomy a format's valid records need is created from what the mapper reads out of the fixture
 * (names carry a per-run suffix so they cannot meet other tests' data), so every valid record resolves.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'formats-test', level: (process.env.TEST_LOG as 'warn' | undefined) ?? 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.formats.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const tr = (name: string, tag: string) => [
  {
    locale: 'en',
    name: `${name} ${tag} ${RUN}`,
    slug: `${name
      .normalize('NFD')
      .replaceAll(/\p{M}/gu, '')
      .toLowerCase()
      .replaceAll(/[^a-z]+/g, '-')}-${tag}-${RUN}`,
  },
];
const suffixed = (s: string, tag: string) => `${s} ${tag} ${RUN}`;

const FORMATS = [
  {
    name: 'Inmoba',
    dir: 'inmoba',
    connector: inmobaConnector,
    record: 'property',
    map: mapInmobaProperty,
    refs: ['10-000017P', 'AR-789789', 'SH-3', 'POR-4', 'SOLD-5'],
    sold: 'SOLD-5',
    refused: ['BAD-6', 'BAD-7', null, 'BAD-9'],
  },
  {
    name: 'Milenio+',
    dir: 'milenio',
    connector: milenioConnector,
    record: 'inmueble',
    map: mapMilenioInmueble,
    refs: ['MIL-001', 'MIL-002', 'MIL-003', 'MIL-004', 'MIL-005'],
    sold: 'MIL-005',
    refused: ['MIL-006', 'MIL-007', null, 'MIL-009'],
  },
  {
    name: 'Infocasa',
    dir: 'infocasa',
    connector: infocasaConnector,
    record: 'propiedad',
    map: mapInfocasaPropiedad,
    refs: ['IC-100', 'IC-101', 'IC-102', 'IC-103', 'IC-104'],
    sold: 'IC-104',
    refused: ['IC-105', 'IC-106', null, 'IC-108'],
  },
  {
    name: 'thinkSPAIN',
    dir: 'thinkspain',
    connector: thinkspainConnector,
    record: 'property',
    map: mapThinkSpainProperty,
    refs: ['TS-1', 'TS-2', 'TS-3', 'TS-4', 'TS-5'],
    sold: 'TS-5',
    refused: ['TS-6', 'TS-7', null, 'TS-9'],
  },
] as const;

let owner: Founder;
const undo: (() => void)[] = [];
const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' }, fn);

const fixtureFile = (dir: string) =>
  fileURLToPath(new URL(`../../../../../../tests/fixtures/${dir}/feed.xml`, import.meta.url));

/** The items a format's mapper reads out of its fixture (valid records only). */
async function validItems(f: (typeof FORMATS)[number]): Promise<FeedListingInput[]> {
  const out: FeedListingInput[] = [];
  for await (const raw of streamXmlRecords(createReadStream(fixtureFile(f.dir)), { recordElement: f.record })) {
    const r = f.map(raw as XmlElement, formatSettings({}, f.connector.key));
    if (r.ok) out.push(r.item);
  }
  return out;
}

/** Creates the countries, regions, cities, areas, property types and features the items name. */
async function createTaxonomy(prefix: string, items: FeedListingInput[]) {
  await system(async (tx) => {
    const ids = new Map<string, string>();
    const location = async (level: 'COUNTRY' | 'REGION' | 'CITY' | 'AREA', path: string[]) => {
      const key = path.join('/');
      const known = ids.get(key);
      if (known) return known;
      const id = await taxonomy.createLocation(tx, {
        level,
        parentId: path.length === 1 ? null : (ids.get(path.slice(0, -1).join('/')) as string),
        code: `${prefix}-${level.toLowerCase()}-${ids.size}-${RUN}`,
        translations: tr(path[path.length - 1] as string, prefix),
      });
      ids.set(key, id);
      return id;
    };
    for (const it of items) {
      const l = it.location ?? {};
      if (!l.country) continue;
      const chain: ['COUNTRY' | 'REGION' | 'CITY' | 'AREA', string | undefined][] = [
        ['COUNTRY', l.country],
        ['REGION', l.region],
        ['CITY', l.city],
        ['AREA', l.area],
      ];
      const path: string[] = [];
      for (const [level, value] of chain) {
        if (!value) break;
        path.push(value);
        await location(level, [...path]);
      }
    }
    const typeGroup = await taxonomy.createPropertyTypeGroup(tx, {
      key: `${prefix}-types-${RUN}`,
      sort: 0,
      translations: tr('Types', prefix),
    });
    for (const name of new Set(items.map((i) => i.propertyType))) {
      await taxonomy.createPropertyType(tx, {
        groupId: typeGroup,
        key: `${prefix}-t-${name.toLowerCase().replaceAll(/[^a-z]+/g, '-')}-${RUN}`,
        sort: 0,
        translations: tr(name, prefix),
      });
    }
    const featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: `${prefix}-features-${RUN}`,
      sort: 0,
      translations: tr('Features', prefix),
    });
    let sort = 0;
    for (const name of new Set(items.flatMap((i) => i.features ?? []))) {
      await taxonomy.createFeature(tx, {
        groupId: featureGroup,
        key: `${prefix}-f-${name.toLowerCase().replaceAll(/[^a-z]+/g, '-')}-${RUN}`,
        sort: sort++,
        icon: 'star',
        translations: tr(name, prefix),
      });
    }
  });
}

beforeAll(async () => {
  await setupTestDb('worker');
  imports.configureImports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    withdrawAfterMissedRuns: 3,
  });
  owner = await createFounder();
  for (const f of FORMATS) {
    const xml = readFileSync(fixtureFile(f.dir));
    undo.push(
      imports.registerConnector({
        ...f.connector,
        key: `${f.connector.key}-fixture`,
        // The mapper's taxonomy text gets the run suffix, like the names created above.
        map: (raw, ctx) => {
          const r = f.connector.map(raw, ctx);
          if (!r.ok) return r;
          const it = r.item;
          const l = it.location ?? {};
          return {
            ...r,
            item: {
              ...it,
              propertyType: suffixed(it.propertyType, f.dir),
              features: it.features?.map((x) => suffixed(x, f.dir)),
              location: {
                ...(l.country ? { country: suffixed(l.country, f.dir) } : {}),
                ...(l.region ? { region: suffixed(l.region, f.dir) } : {}),
                ...(l.city ? { city: suffixed(l.city, f.dir) } : {}),
                ...(l.area ? { area: suffixed(l.area, f.dir) } : {}),
              },
            },
          };
        },
        fetch: async () => ({
          body: Readable.from([xml]),
          bytesRead: () => xml.length,
          contentType: 'application/xml',
        }),
      }),
    );
    // Taxonomy is created with the suffix already in the name (tr adds it).
    await createTaxonomy(f.dir, await validItems(f));
  }
}, 240_000);

afterAll(async () => {
  for (const u of undo) u();
  await closeDb();
});

describe.each(FORMATS)('$name fixture run', (f) => {
  it('[S6-07] the fixture feed imports end to end: valid records become listings with taxonomy resolved, refused ones are reported', async () => {
    const c = await as((ctx) =>
      imports.createFeedConnection(
        ctx,
        CreateFeedConnectionBody.parse({
          name: `${f.name} fixture`,
          connector: `${f.connector.key}-fixture`,
          url: 'https://feeds.example.test/feed.xml',
          scheduleMinutes: null,
          settings: {},
        }),
      ),
    );
    const run = await as((ctx) => imports.requestFeedRun(ctx, c.id));
    const outcome = await imports.executeRun({ runId: run.id, agencyId: owner.agencyId }, job());
    expect(outcome).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    const dto = await as((ctx) => imports.getFeedRun(ctx, run.id));
    expect(dto.counts).toMatchObject({ total: 9, valid: 5, failed: 4, created: 5, held: 0 });
    const errors = await as((ctx) => imports.listFeedItemErrors(ctx, run.id, { limit: 10 }));
    expect(errors.items.map((e) => e.itemRef)).toEqual(f.refused);

    type Row = {
      ref: string;
      status: string;
      transaction_type: string;
      price_cents: string | null;
      held: string[] | null;
      features: string;
      locales: string;
    };
    const stored = new Map(
      (
        await rows<Row>(sql`
          select pp.external_ref as ref, p.status, p.transaction_type, p.price_cents, pp.import_held as held,
                 (select count(*)::text from property_features x where x.property_id = p.id) as features,
                 (select string_agg(t.locale, ',' order by t.locale) from property_translations t where t.property_id = p.id) as locales
            from properties p join property_privates pp on pp.property_id = p.id
           where p.agency_id = ${owner.agencyId} and pp.import_connection_id = ${c.id}`)
      ).map((r) => [r.ref, r]),
    );
    expect([...stored.keys()].sort()).toEqual([...f.refs].sort());
    for (const r of stored.values()) expect(r.held).toBeNull();
    expect(stored.get(f.refs[0])).toMatchObject({
      transaction_type: 'SALE',
      price_cents: f.name === 'Inmoba' ? '26000000' : '125000000',
    });
    expect(stored.get(f.refs[1])).toMatchObject({ transaction_type: 'RENT_LONG_TERM', price_cents: '180000' });
    expect(stored.get(f.refs[2])?.transaction_type).toBe('RENT_SHORT_TERM');
    expect(stored.get(f.refs[3])).toMatchObject({ price_cents: null });
    expect(stored.get(f.sold)?.status).toBe('SOLD');
    expect(Number(stored.get(f.refs[0])?.features)).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
