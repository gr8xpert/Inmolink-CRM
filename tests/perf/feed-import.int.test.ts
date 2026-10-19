import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CreateFeedConnectionBody } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as imports from '@inmolink/core/modules/imports';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * Feed import throughput (S6-02 acceptance): a 100 MB feed (~20k listings: three descriptions, features, 15 image
 * URLs each) imports in < 10 min with the worker under 512 MB RSS, and re-importing it unchanged changes 0 rows and
 * emits 0 events. The run is `imports.executeRun` with the listing loader in a process of its own (plain node on the
 * built packages, `feed-import.child.ts`): fetched over HTTP from a loopback origin through `safeFetch`, parsed as a
 * stream, staged and MERGEd in batches of 500. In the `perf` project: it runs alone.
 */

const RUN = newId().slice(-8).toLowerCase();
const FEED_BYTES = 100 * 1024 * 1024;
const BUDGET_MS = 10 * 60_000;
const RSS_BUDGET = 512 * 1024 * 1024;
const run$ = promisify(execFile);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.feedImport', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let owner: Founder;
let server: Server;
let origin: string;
let feedPath: string;
let listings = 0;
const undo: (() => void)[] = [];

/** The taxonomy the feed uses: 1 country, 3 regions, 4 cities each, 4 areas each; 8 types; 24 features. */
const tax = {
  country: `Perfonia ${RUN}`,
  regions: [] as { name: string; cities: { name: string; areas: string[] }[] }[],
  types: Array.from({ length: 8 }, (_, i) => `Perf Type ${i} ${RUN}`),
  features: Array.from({ length: 24 }, (_, i) => `Perf Feature ${i} ${RUN}`),
};

const LOREM =
  'Bright south-facing home a short walk from the beach, with open views over the bay and the mountains. ' +
  'The living room opens onto a covered terrace; the kitchen is fitted and the bedrooms have built-in wardrobes. ';

function listingXml(i: number): string {
  const region = tax.regions[i % 3] as (typeof tax.regions)[number];
  const city = region.cities[i % 4] as (typeof region.cities)[number];
  const area = city.areas[(i >> 2) % 4] as string;
  const features = [0, 5, 9, 13, 17, 21].map((f) => `<feature>${tax.features[(i + f) % 24]}</feature>`).join('');
  const desc = (lang: string) =>
    `<desc lang="${lang}"><title>Villa ${i} ${lang}</title><text>${LOREM.repeat(6)}${lang} ${i}</text></desc>`;
  const images = Array.from(
    { length: 15 },
    (_, n) => `<image>https://img.example.com/feeds/${RUN}/p${i}/photo-${n}.jpg</image>`,
  ).join('');
  return (
    `<property><ref>PF-${i}</ref><type>${tax.types[i % 8]}</type><country>${tax.country}</country>` +
    `<region>${region.name}</region><city>${city.name}</city><area>${area}</area>` +
    `<price>${200_000 + (i % 500) * 1_000}</price><beds>${1 + (i % 6)}</beds><baths>${1 + (i % 4)}</baths>` +
    `<built>${60 + (i % 300)}</built><plot>${i % 2 ? 500 + i : ''}</plot><energy>${'ABCDEFG'[i % 7]}</energy>` +
    `<lat>${(36 + (i % 1000) / 1000).toFixed(6)}</lat><lng>${(-4.9 + (i % 700) / 1000).toFixed(6)}</lng>` +
    `<features>${features}</features>${desc('en')}${desc('es')}${desc('de')}<images>${images}</images></property>\n`
  );
}

/** Writes listings until the file reaches 100 MB (with back-pressure); answers how many. */
async function writeFeed(path: string): Promise<number> {
  const out = createWriteStream(path);
  out.write('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n');
  let bytes = 0;
  let i = 0;
  while (bytes < FEED_BYTES) {
    const chunk = listingXml(i++);
    bytes += Buffer.byteLength(chunk);
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end('</root>\n');
  await once(out, 'finish');
  return i;
}

/** Every row version of the agency's listings and children, as one hash (xmin changes when a row is written). */
async function rowVersions(): Promise<string> {
  const [r] = await rows<{ v: string }>(sql`
    select md5(concat_ws('|',
      (select string_agg(id::text || ':' || xmin::text, ',' order by id) from properties where agency_id = ${owner.agencyId}),
      (select string_agg(property_id::text || ':' || xmin::text, ',' order by property_id) from property_privates
        where agency_id = ${owner.agencyId}),
      (select string_agg(property_id::text || locale || ':' || xmin::text, ',' order by property_id, locale)
         from property_translations where agency_id = ${owner.agencyId}),
      (select string_agg(property_id::text || feature_id::text || ':' || xmin::text, ',' order by property_id, feature_id)
         from property_features where agency_id = ${owner.agencyId}),
      (select count(*)::text from property_status_histories where agency_id = ${owner.agencyId}),
      (select count(*)::text from property_price_histories where agency_id = ${owner.agencyId}))) as v`);
  return r?.v ?? '';
}

async function importOnce(connectionId: string) {
  const run = await withMemberCtx(
    { userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' },
    (ctx) => imports.requestFeedRun(ctx, connectionId),
  );
  const { stdout } = await run$(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      join(import.meta.dirname, 'feed-import.child.ts'),
      JSON.stringify({ runId: run.id, agencyId: owner.agencyId, origin }),
    ],
    {
      encoding: 'utf8',
      timeout: 20 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, APP_ROLE: 'worker' },
    },
  );
  const lines = stdout.trim().split('\n');
  // The worker's own warnings (a failed run says why).
  for (const line of lines.slice(0, -1))
    console.warn(line.length > 4_000 ? `${line.slice(0, 1_000)} … ${line.slice(-3_000)}` : line);
  const result = JSON.parse(lines.at(-1) as string) as {
    base: number;
    peak: number;
    maxRss: number;
    ms: number;
    outcome: { kind: string; state?: string };
  };
  const dto = await withMemberCtx(
    { userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' },
    (ctx) => imports.getFeedRun(ctx, run.id),
  );
  return { ...result, run: dto };
}

const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;

beforeAll(async () => {
  await setupTestDb('worker');
  imports.configureImports({ keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }) });
  owner = await createFounder();
  await system(async (tx) => {
    const tr = (name: string) => [{ locale: 'en', name, slug: name.toLowerCase().replaceAll(' ', '-') }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `pf-${RUN}`,
      translations: tr(tax.country),
    });
    for (let r = 0; r < 3; r++) {
      const name = `Perf Region ${r} ${RUN}`;
      const region = await taxonomy.createLocation(tx, { level: 'REGION', parentId: country, translations: tr(name) });
      const entry = { name, cities: [] as { name: string; areas: string[] }[] };
      for (let c = 0; c < 4; c++) {
        const cityName = `Perf City ${r}${c} ${RUN}`;
        const city = await taxonomy.createLocation(tx, { level: 'CITY', parentId: region, translations: tr(cityName) });
        const areas: string[] = [];
        for (let a = 0; a < 4; a++) {
          const areaName = `Perf Area ${r}${c}${a} ${RUN}`;
          await taxonomy.createLocation(tx, { level: 'AREA', parentId: city, translations: tr(areaName) });
          areas.push(areaName);
        }
        entry.cities.push({ name: cityName, areas });
      }
      tax.regions.push(entry);
    }
    const typeGroup = await taxonomy.createPropertyTypeGroup(tx, {
      key: `pf-types-${RUN}`,
      sort: 0,
      translations: tr(`Perf Types ${RUN}`),
    });
    for (const [i, name] of tax.types.entries()) {
      await taxonomy.createPropertyType(tx, {
        groupId: typeGroup,
        key: `pf-t${i}-${RUN}`,
        sort: i,
        translations: tr(name),
      });
    }
    const featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: `pf-features-${RUN}`,
      sort: 0,
      translations: tr(`Perf Features ${RUN}`),
    });
    for (const [i, name] of tax.features.entries()) {
      await taxonomy.createFeature(tx, {
        groupId: featureGroup,
        key: `pf-f${i}-${RUN}`,
        sort: i,
        icon: 'waves',
        translations: tr(name),
      });
    }
  });
  feedPath = join(tmpdir(), `inmolink-perf-feed-${RUN}.xml`);
  listings = await writeFeed(feedPath);
  server = createServer((req, res) => {
    if (req.url !== '/feed.xml') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/xml', 'content-length': statSync(feedPath).size });
    createReadStream(feedPath).pipe(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  undo.push(allowLoopbackOriginsForTests([origin]));
  // The connection names the connector; only the child process runs it.
  undo.push(
    imports.registerConnector({
      key: 'perf-xml',
      fetch: () => Promise.reject(new Error('runs in feed-import.child.ts')),
      parse: async function* () {},
      map: () => ({ ok: false, problems: [{ code: 'UNUSED' }] }),
      validate: () => [],
    }),
  );
}, 600_000);

afterAll(async () => {
  for (const u of undo) u();
  server?.close();
  if (feedPath) unlinkSync(feedPath);
  // Their queued feed images: no media worker runs here, and the next perf run must not inherit 20k rows.
  if (owner) await system((tx) => tx.execute(sql`delete from feed_image_queue where agency_id = ${owner.agencyId}`));
  await closeDb();
});

it('[S6-02] a 100 MB feed imports in < 10 min with RSS < 512 MB; re-importing it unchanged changes 0 rows and emits 0 events', async () => {
  const size = statSync(feedPath).size;
  const connection = await withMemberCtx(
    { userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' },
    (ctx) =>
      imports.createFeedConnection(
        ctx,
        CreateFeedConnectionBody.parse({
          name: 'Perf feed',
          connector: 'perf-xml',
          url: `${origin}/feed.xml`,
          scheduleMinutes: null,
        }),
      ),
  );

  const first = await importOnce(connection.id);
  console.info(
    `[S6-02] first import: ${listings} listings, ${mb(size)} feed in ${(first.ms / 1000).toFixed(1)} s ` +
      `(${((listings / first.ms) * 1000).toFixed(0)} listings/s); child RSS idle ${mb(first.base)}, ` +
      `peak ${mb(first.peak)}, maxRSS ${mb(first.maxRss)}`,
  );
  expect(first.outcome).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
  expect(first.run.counts).toMatchObject({ total: listings, valid: listings, failed: 0, created: listings, held: 0 });
  expect(first.ms).toBeLessThan(BUDGET_MS);
  expect(Math.max(first.peak, first.maxRss)).toBeLessThan(RSS_BUDGET);

  const before = await rowVersions();
  const since = new Date();
  const second = await importOnce(connection.id);
  console.info(
    `[S6-02] unchanged re-import: ${(second.ms / 1000).toFixed(1)} s, peak RSS ${mb(Math.max(second.peak, second.maxRss))}`,
  );
  expect(second.run.counts).toMatchObject({
    valid: listings,
    created: 0,
    updated: 0,
    unchanged: listings,
    withdrawn: 0,
  });
  expect(await rowVersions()).toBe(before);
  const [events] = await rows<{ n: string }>(sql`
    select count(*)::text as n from outbox_events
     where agency_id = ${owner.agencyId} and type like 'properties.%' and created_at >= ${since.toISOString()}::timestamptz`);
  expect(events?.n).toBe('0');
  expect(second.ms).toBeLessThan(BUDGET_MS);
}, 1_800_000);
