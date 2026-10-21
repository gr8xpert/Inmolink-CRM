import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { withMemberCtx } from '@inmolink/core';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureStorage, createS3Store, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { validateXML } from 'xmllint-wasm';

/**
 * Per-site XML feed generation at size (S7-07: streamed, batched, RSS < 512 MB on a 2,000+ listing site). Seeds
 * `SITE_FEED_PERF_ROWS` PUBLIC listings of one agency (read models in `en` and `es`: a 1 KB description and ten
 * images each, fallback rows, public codes), then runs the generator for its two-language site in a process of its own
 * on the built packages (`site-feed.child.ts`, like the media burst) — two sites at once, the pool's per-process
 * cap — streaming to MinIO, sampling that process's RSS: the worker's budget is 512 MB. A run in this process counts
 * the statements; the stored Kyero file is validated against the schema fixture at full size.
 */

const log = createLogger({ service: 'perf', level: 'info' });
const ROWS = Number(process.env.SITE_FEED_PERF_ROWS ?? 2_500);
const RSS_BUDGET_MB = 512;
const RUN = newId().slice(-8);
const space = '0195f0a5-0311-7000-8000-';
const idSql = (n: string) => `('${space}' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const XSD = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'kyero', 'kyero-v3.xsd'), 'utf8');

let a: Founder;
const siteIds: string[] = [];
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.site-feed', fn);
const runSql = (q: string) =>
  system(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '5min'`);
    return tx.execute(sql.raw(q));
  });

const media = `(select jsonb_agg(jsonb_build_object('kind', 'IMAGE', 'cover', i = 1, 'alt', 'Room ' || i, 'room', null,
    'width', 1600, 'height', 1067, 'variants', jsonb_build_object('large', 'v1/p' || g || 'i' || i || '/large.webp',
    'thumb', 'v1/p' || g || 'i' || i || '/thumb.webp'))) from generate_series(1, 10) i)`;

const card = (locale: string) => `jsonb_build_object(
  'kind', 'LISTING', 'id', ${idSql('g')}, 'ref', 'SF' || g, 'status', 'ACTIVE', 'transactionType', 'SALE',
  'price', jsonb_build_object('amountCents', (100000 + g) * 100, 'currency', 'EUR', 'period', null, 'onRequest', false),
  'propertyType', jsonb_build_object('id', '0195f0a5-0005-7000-8000-000000000001', 'name', 'Villa', 'slug', 'villa'),
  'place', jsonb_build_object('country', jsonb_build_object('id', '0195f0a5-0005-7000-8000-000000000002', 'name', 'Spain',
    'slug', 'spain'), 'region', jsonb_build_object('id', '0195f0a5-0005-7000-8000-000000000003', 'name', 'Málaga',
    'slug', 'malaga'), 'city', jsonb_build_object('id', '0195f0a5-0005-7000-8000-000000000004', 'name', 'Marbella',
    'slug', 'marbella'), 'area', null),
  'bedrooms', g % 6, 'bathrooms', 1 + g % 3, 'builtM2', 40 + g % 400, 'plotM2', null,
  'geo', jsonb_build_object('lat', 36.5, 'lng', -4.9, 'precision', 'APPROX'), 'cover', null, 'imageCount', 10,
  'developmentId', null, 'title', '${locale} villa ' || g, 'slug', '${locale}-villa-' || g, 'textLocale', null)`;

const detail = (locale: string) => `${card(locale)} || jsonb_build_object(
  'description', repeat('${locale}: a bright villa with sea views, a pool & a large <terrace>. ', 15),
  'metaTitle', null, 'metaDescription', null, 'terraceM2', 20, 'yearBuilt', 2010, 'energyRating', 'B',
  'energyEmissionsRating', null,
  'features', jsonb_build_array(jsonb_build_object('id', '0195f0a5-0005-7000-8000-000000000005', 'name', 'Pool',
    'slug', 'pool')),
  'media', ${media})`;

const cleanup = async () => {
  for (const table of ['listing_read_models', 'listing_search_docs', 'listing_public_codes']) {
    await runSql(`delete from ${table} where target_id::text like '${space}%'`);
  }
};

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:perf-feed:${RUN}` });
  websites.configureSiteFeeds({ tokenKey: 'test-hmac-key-0123456789abcdef0123456789' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  await cleanup();
  const series = `generate_series(1, ${ROWS}) g`;
  await runSql(`insert into listing_public_codes (target_id, code)
    select ${idSql('g')}, 'S' || upper(lpad(to_hex(g), 7, '0')) from ${series} on conflict do nothing`);
  await runSql(`insert into listing_search_docs (target_id, kind, owner_agency_id, status, transaction_type,
      property_type_id, location_ids, feature_ids, price_cents, price_on_request, beds, baths, area_m2, lat, lng, ref,
      public_code, share_scope, preferred_agency_ids, network_hidden, published_at, version, source_hash)
    select ${idSql('g')}, 'LISTING', '${a.agencyId}', 'ACTIVE', 'SALE', '0195f0a5-0005-7000-8000-000000000001', '{}',
           '{}', (100000 + g) * 100, false, g % 6, 1 + g % 3, 40 + g % 400, 36.5, -4.9, 'SF' || g,
           'S' || upper(lpad(to_hex(g), 7, '0')), 'ALL', '{}', false, 1700000000 + g, 1, 'h' || g
      from ${series}`);
  for (const locale of ['en', 'es']) {
    await runSql(`insert into listing_read_models (target_id, locale, kind, agency_id, public, status, share_scope,
        version, card, detail, etag)
      select ${idSql('g')}, '${locale}', 'LISTING', '${a.agencyId}', true, 'ACTIVE', 'ALL', 1, ${card(locale)},
             ${detail(locale)}, 'e' || g
        from ${series}`);
  }
  await adminQuery('vacuum analyze listing_read_models');
  for (const name of ['one', 'two']) {
    const site = await withMemberCtx(
      { userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' },
      (ctx) =>
        websites.createSite(ctx, {
          name: `Perf feed ${name}`,
          domains: [`www.perf-feed-${name}.example`],
          mode: 'WP_PLUGIN',
          inventoryPolicy: 'OWN_ONLY',
          inventoryFilters: null,
          referencePrefix: 'PF',
          locales: ['en', 'es'],
          contact: null,
        }),
    );
    siteIds.push(site.id);
  }
}, 10 * 60_000);

afterAll(async () => {
  await cleanup().catch(() => undefined);
  // The runs' files in MinIO.
  for (const siteId of siteIds) {
    const page = await storage().list('feeds', `site-feeds/${siteId}/`, { limit: 1_000 });
    for (const o of page.objects) await storage().delete('feeds', o.key);
  }
  await closeCache();
  await closeDb();
});

it('[S7-07] two 2,000+ listing feeds generated at once (the per-process cap) stream within the worker memory budget', async () => {
  const tokens: string[] = [];
  for (const siteId of siteIds) {
    const rotated = await withMemberCtx(
      { userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' },
      (ctx) => websites.rotateSiteFeed(ctx, { siteId }),
    );
    tokens.push(rotated.secret.token);
  }
  // The jobs alone in a process of its own, on the built packages (plain node, as the worker container runs them),
  // streaming to the test stack's MinIO.
  const started = performance.now();
  const out = execFileSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, 'site-feed.child.ts'), siteIds.join(',')],
    { encoding: 'utf8', timeout: 240_000, env: { ...process.env, APP_ROLE: 'worker' } },
  );
  const seconds = (performance.now() - started) / 1_000;
  const child = JSON.parse(out.trim().split(String.fromCharCode(10)).pop() as string) as {
    base: number;
    peak: number;
    runs: { items: number; kyero: number; invalid: number; bytes: { kyero: number; generic: number } }[];
  };
  const mb = (n: number) => Math.round(n / 1_048_576);
  expect(child.runs).toHaveLength(2);
  for (const run of child.runs) expect(run).toMatchObject({ items: ROWS, kyero: ROWS, invalid: 0 });
  // In this process: statements of one run (one sitemap page + per locale one read-model statement per 200 items;
  // a network site adds one view statement per locale and batch).
  const statements = await countQueries(async () => {
    await websiteApi.generateSiteFeed(siteIds[0] as string);
  });
  log.info(
    {
      rows: ROWS,
      concurrentRuns: 2,
      childSeconds: Math.round(seconds * 10) / 10,
      statementsPerRun: statements,
      rssIdleMb: mb(child.base),
      rssPeakMb: mb(child.peak),
      kyeroGzipKb: Math.round((child.runs[0]?.bytes.kyero ?? 0) / 1024),
      genericGzipKb: Math.round((child.runs[0]?.bytes.generic ?? 0) / 1024),
    },
    'site feeds generated',
  );
  expect(mb(child.peak)).toBeLessThan(RSS_BUDGET_MB);
  expect(statements).toBeLessThanOrEqual(Math.ceil(ROWS / websiteApi.SITE_FEED_BATCH) * 3 + 10);

  const served = await websiteApi.siteFeedFile(tokens[0] as string, 'kyero.xml');
  const xml = gunzipSync(Buffer.concat(await (await served.open()).toArray())).toString('utf8');
  const check = await validateXML({
    xml: [{ fileName: 'kyero.xml', contents: xml }],
    schema: [XSD],
    maxMemoryPages: 16 * 1024,
  });
  expect(check.errors.slice(0, 3).map((e) => e.rawMessage)).toEqual([]);
  expect(xml.match(/<property>/g)).toHaveLength(ROWS);
});
