import { gzipSync } from 'node:zlib';
import { withMemberCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../apps/feed-api/src/app';

/**
 * Website API v2 at scale (S7-03 acceptance: each endpoint ≤ 3 queries, p95 < 150 ms at origin). Seeds
 * `WEBSITE_PERF_ROWS` PUBLIC listings (read model in one locale, fallback row, public code) over
 * `WEBSITE_PERF_AGENCIES` owner agencies (one real, the sites' agency; the rest bulk rows) — 1 in 100 also in a city —
 * and a change log of 3 rows per listing, then measures feed-api requests (`app.inject`: routing, key check, core reads,
 * serializer, contract check, JSON, ETag) one at a time with the search engine stopped (website search answers from
 * the Postgres fallback, its slowest backend). Sites: OWN_ONLY, CUSTOM own + network in the country, CUSTOM network
 * only in the city (narrow). Queries are counted warm and with the compiled owner identities dropped. The 2M-document
 * check runs on the staging-sized box (H4, with S5-02 / S5-04): `WEBSITE_PERF_ROWS=2000000 pnpm test:perf:root`.
 *
 * S7-F6 adds new-build units — one per ten listings, 20 per development (1 development in 50 the sites' agency's,
 * 1 in 100 in the city; 1 unit in 5 RESERVED, 1 in 7 SOLD) — and measures `/v2/developments` (own, network-wide,
 * narrow, a deep cursor), a development's detail and unit table, and search by a development's site reference.
 */

const log = createLogger({ service: 'perf', level: 'info' });
const ROWS = Number(process.env.WEBSITE_PERF_ROWS ?? 100_000);
const AGENCIES = Number(process.env.WEBSITE_PERF_AGENCIES ?? 2_000);
const BATCH = 50_000;
/** S7-F6: new-build units (one per ten listings), twenty per development. */
const UNITS = Math.floor(ROWS / 10);
const UNITS_PER_DEVELOPMENT = 20;
const DEVELOPMENTS = Math.ceil(UNITS / UNITS_PER_DEVELOPMENT);
/** S7-F6 review: a few large developments (2,000 units each), the newest, after the others. */
const BIG_DEVELOPMENTS = 5;
const BIG_UNITS = 2_000;
const ALL_UNITS = UNITS + BIG_DEVELOPMENTS * BIG_UNITS;
/** Development number of unit u (the big ones after the regular ones). */
const DEVELOPMENT_OF = `(case when u <= ${UNITS} then (u - 1) / ${UNITS_PER_DEVELOPMENT} + 1
  else ${DEVELOPMENTS} + 1 + (u - ${UNITS} - 1) / ${BIG_UNITS} end)`;
const REQUESTS = 50;
const P95_BUDGET_MS = 150;
const RUN = newId().slice(-8);
/** This test's own id spaces: listings `0195f0a5-0301-…`, bulk agencies `0195f0a5-0302-…`. */
const space = (s: number) => `0195f0a5-${s.toString(16).padStart(4, '0')}-7000-8000-`;
const idSql = (n: string) => `('${space(0x0301)}' || lpad(to_hex(${n}), 12, '0'))::uuid`;
/** Units `0195f0a5-0303-…`, developments `0195f0a5-0304-…` (UUIDv7-like: a higher number is newer). */
const unitIdSql = (n: string) => `('${space(0x0303)}' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const devIdSql = (n: string) => `('${space(0x0304)}' || lpad(to_hex(${n}), 12, '0'))::uuid`;
/** Development d's public code (`X…`) and unit u's (`Y…`). */
const devCode = (d: number) => `X${d.toString(16).toUpperCase().padStart(7, '0')}`;

const allow = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;

type SiteName = 'own' | 'network' | 'narrow' | 'commission';
let a: Founder;
let app: Awaited<ReturnType<typeof buildApp>>;
const keys: Record<SiteName, string> = { own: '', network: '', narrow: '', commission: '' };
/** This run's country and a city in it (CUSTOM sites select them; the test database holds other suites' rows). */
let country = '';
let city = '';

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.website-api', fn);
const runSql = (q: string) =>
  system(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '15min'`);
    return tx.execute(sql.raw(q));
  });

/** Row g's owner: the sites' agency for every multiple of AGENCIES, else a bulk agency. */
const ownerSql = (g: string) =>
  `case when ${g} % ${AGENCIES} = 0 then '${a.agencyId}'::uuid
        else ('${space(0x0302)}' || lpad(to_hex(${g} % ${AGENCIES}), 12, '0'))::uuid end`;
const code = (g: number) => `Z${g.toString(16).toUpperCase().padStart(7, '0')}`;

/** Listings `from`..`to`: fallback rows, read models (card + detail, `en`), public codes, change log. */
const seed = (from: number, to: number) => [
  `insert into listing_public_codes (target_id, code)
   select ${idSql('g')}, 'Z' || upper(lpad(to_hex(g), 7, '0')) from generate_series(${from}, ${to}) g
   on conflict do nothing`,
  `insert into listing_search_docs (target_id, kind, owner_agency_id, status, transaction_type, property_type_id,
     location_ids, feature_ids, price_cents, price_on_request, beds, baths, area_m2, lat, lng, ref, public_code,
     share_scope, preferred_agency_ids, network_hidden, published_at, version, source_hash)
   select ${idSql('g')}, 'LISTING', ${ownerSql('g')}, 'ACTIVE', 'SALE',
          '0195f0a5-0005-7000-8000-000000000001',
          case when g % 100 = 7 then array['${country}'::uuid, '${city}'::uuid] else array['${country}'::uuid] end, '{}',
          (100000 + (g::bigint * 7919) % 900000) * 100, false, (g % 6)::int, (1 + g % 3)::int, 40 + g % 400,
          36.5 + (g % 600) / 100.0, -5 + (g % 800) / 100.0, 'PF' || g, 'Z' || upper(lpad(to_hex(g), 7, '0')),
          'ALL', '{}', false, 1700000000 + (g::bigint * 104729) % 60000000, 1, 'h' || g
     from generate_series(${from}, ${to}) g`,
  `insert into listing_read_models (target_id, locale, kind, agency_id, public, status, share_scope, version, card,
     detail, etag)
   select ${idSql('g')}, 'en', 'LISTING', ${ownerSql('g')}, true, 'ACTIVE', 'ALL', 1, c.card,
          c.card || jsonb_build_object('description', repeat('A bright villa with sea views and a large terrace. ', 12),
            'metaTitle', null, 'metaDescription', null, 'terraceM2', 20, 'yearBuilt', 2010, 'energyRating', 'B',
            'energyEmissionsRating', null, 'features', '[]'::jsonb, 'media', '[]'::jsonb),
          'e' || g
     from generate_series(${from}, ${to}) g,
     lateral (select jsonb_build_object(
       'kind', 'LISTING', 'id', ${idSql('g')}, 'ref', 'PF' || g, 'status', 'ACTIVE', 'transactionType', 'SALE',
       'price', jsonb_build_object('amountCents', (100000 + (g::bigint * 7919) % 900000) * 100, 'currency', 'EUR',
         'period', null, 'onRequest', false),
       'propertyType', jsonb_build_object('id', '0195f0a5-0005-7000-8000-000000000001', 'name', 'Villa', 'slug', 'villa'),
       'place', jsonb_build_object('country', jsonb_build_object('id', '${country}', 'name', 'Spain', 'slug', 'spain'),
         'region', null, 'city', null, 'area', null),
       'bedrooms', g % 6, 'bathrooms', 1 + g % 3, 'builtM2', 40 + g % 400, 'plotM2', null,
       'geo', jsonb_build_object('lat', 36.5, 'lng', -5, 'precision', 'APPROX'), 'cover', null, 'imageCount', 0,
       'developmentId', null, 'title', 'Villa with sea views ' || g, 'slug', 'villa-with-sea-views-' || g,
       'textLocale', null) as card) c`,
  // Three changes per listing (the log's age spread over the last day).
  `insert into listing_public_changes (target_id, kind, owner_agency_id, ref, shared_all, changed_at)
   select ${idSql('g')}, 'LISTING', ${ownerSql('g')}, 'PF' || g, true,
          now() - make_interval(secs => (${to} - g) % 86400)
     from generate_series(${from}, ${to}) g, generate_series(1, 3) k`,
];

/** Units `from`..`to` (S7-F6): fallback rows, read models (card + detail, `en`), public codes of units and developments. */
const seedUnits = (from: number, to: number) => {
  const d = DEVELOPMENT_OF;
  const owner = `case when ${d} % 50 = 0 then '${a.agencyId}'::uuid
        else ('${space(0x0302)}' || lpad(to_hex(1 + ${d} % ${AGENCIES - 1}), 12, '0'))::uuid end`;
  const status = `case when u % 7 = 0 then 'SOLD' when u % 5 = 0 then 'RESERVED' else 'AVAILABLE' end`;
  const price = `(150000 + (u::bigint * 7919) % 600000) * 100`;
  return [
    `insert into listing_public_codes (target_id, code)
     select ${unitIdSql('u')}, 'Y' || upper(lpad(to_hex(u), 7, '0')) from generate_series(${from}, ${to}) u
     union all
     select distinct ${devIdSql(d)}, 'X' || upper(lpad(to_hex(${d}), 7, '0')) from generate_series(${from}, ${to}) u
     on conflict do nothing`,
    `insert into listing_search_docs (target_id, kind, owner_agency_id, development_id, status, transaction_type,
       property_type_id, location_ids, feature_ids, price_cents, price_on_request, beds, baths, area_m2, lat, lng, ref,
       public_code, share_scope, preferred_agency_ids, network_hidden, published_at, version, source_hash)
     select ${unitIdSql('u')}, 'UNIT', ${owner}, ${devIdSql(d)}, ${status}, 'SALE',
            '0195f0a5-0005-7000-8000-000000000001',
            case when ${d} % 100 = 7 then array['${country}'::uuid, '${city}'::uuid] else array['${country}'::uuid] end,
            '{}', ${price}, false, (u % 5)::int, (1 + u % 2)::int, 50 + u % 150, 36.5 + (${d} % 600) / 100.0,
            -5 + (${d} % 800) / 100.0, 'PU' || u, 'Y' || upper(lpad(to_hex(u), 7, '0')), 'ALL', '{}', false,
            1700000000 + (u::bigint * 104729) % 60000000, 1, 'hu' || u
       from generate_series(${from}, ${to}) u`,
    `insert into listing_read_models (target_id, locale, kind, agency_id, development_id, public, status, version, card,
       detail, etag)
     select ${unitIdSql('u')}, 'en', 'UNIT', ${owner}, ${devIdSql(d)}, true, ${status}, 1, c.card,
            c.card || jsonb_build_object('description', repeat('New homes with sea views and gardens. ', 12),
              'paymentTerms', '10 % on reservation', 'metaTitle', null, 'metaDescription', null, 'phase', null),
            'eu' || u
       from generate_series(${from}, ${to}) u,
       lateral (select jsonb_build_object(
         'kind', 'UNIT', 'id', ${unitIdSql('u')}, 'ref', 'PU' || u, 'status', ${status},
         'price', jsonb_build_object('amountCents', ${price}, 'currency', 'EUR', 'period', null, 'onRequest', false),
         'propertyType', jsonb_build_object('id', '0195f0a5-0005-7000-8000-000000000001', 'name', 'Flat', 'slug', 'flat'),
         'place', jsonb_build_object('country', jsonb_build_object('id', '${country}', 'name', 'Spain', 'slug', 'spain'),
           'region', null, 'city', null, 'area', null),
         'bedrooms', u % 5, 'bathrooms', 1 + u % 2, 'internalM2', 50 + u % 150, 'terraceM2', 10, 'plotM2', null,
         'floor', u % 8, 'orientation', null,
         'geo', jsonb_build_object('lat', 36.5, 'lng', -5, 'precision', 'EXACT'),
         'development', jsonb_build_object('id', ${devIdSql(d)}, 'name', 'Perf Gardens ' || ${d},
           'status', 'UNDER_CONSTRUCTION', 'completionDate', '2027-06-30'),
         'title', 'Perf Gardens ' || ${d}, 'slug', 'perf-gardens-' || ${d}, 'textLocale', null) as card) c`,
    // Commission (S7-F4) of every unit: 4 % on even units, 2 % on odd ones (the commission site keeps ≥ 3 %).
    `insert into listing_search_commissions (target_id, commission_bp)
     select ${unitIdSql('u')}, case when u % 2 = 0 then 400 else 200 end from generate_series(${from}, ${to}) u
     on conflict do nothing`,
  ];
};

/** Development rows (S7-F6) as the search worker writes them: aggregates over the shown units, own ref `PD<d>`. */
const seedDevelopmentRows = `
  insert into listing_search_developments (development_id, owner_agency_id, ref, location_ids, units, available,
         reserved, price_min_cents, price_max_cents, beds_min, beds_max, rep_target_id)
  select a.id, r.owner_agency_id, 'PD' || ('x' || lpad(right(a.id::text, 12), 16, '0'))::bit(64)::bigint,
         r.location_ids, a.units, a.available, a.reserved, a.pmin, a.pmax, a.bmin, a.bmax, a.rep
    from (select development_id as id, count(*)::int as units,
                 (count(*) filter (where status = 'AVAILABLE'))::int as available,
                 (count(*) filter (where status = 'RESERVED'))::int as reserved,
                 min(price_cents) filter (where status = 'AVAILABLE') as pmin,
                 max(price_cents) filter (where status = 'AVAILABLE') as pmax, min(beds) as bmin, max(beds) as bmax,
                 (array_agg(target_id order by target_id))[1] as rep
            from listing_search_docs
           where development_id::text like '${space(0x0304)}%' and kind = 'UNIT' and status in ('AVAILABLE', 'RESERVED')
           group by development_id) a
    join listing_search_docs r on r.target_id = a.rep`;

const cleanup = async () => {
  await runSql(`delete from listing_search_developments where development_id::text like '${space(0x0304)}%'`);
  await runSql(`delete from listing_search_commissions where target_id::text like '${space(0x0303)}%'`);
  for (const s of [0x0301, 0x0303, 0x0304]) {
    const like = `'${space(s)}%'`;
    for (const table of [
      'listing_public_changes',
      'listing_read_models',
      'listing_search_docs',
      'listing_public_codes',
    ]) {
      await runSql(`delete from ${table} where target_id::text like ${like}`);
    }
  }
  await adminQuery(`delete from agencies where agency_id::text like '${space(0x0302)}%'`);
};

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:perf-wapi:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  search.configureNetworkSearch({ giveToGetMinShared: 0, giveToGetGraceDays: 0 });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  // The engine is stopped: the first failure opens the breaker, every search below uses the fallback.
  search.resetSearchBreaker({ failureThreshold: 1, openMs: 3_600_000 });
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  ({ country, city } = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const c = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `pw-${RUN}`,
      translations: name('Perfland'),
    });
    const r = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: c,
      code: `pw-r-${RUN}`,
      translations: name('Coast'),
    });
    const t = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: r,
      code: `pw-c-${RUN}`,
      translations: name('Port'),
    });
    return { country: c, city: t };
  }));
  await cleanup();
  const started = Date.now();
  // Bulk owner agencies (no user, not listed): rows for the read models' foreign key; triggers skipped.
  await adminQuery(`set session_replication_role = replica;
    insert into agencies (agency_id, kind, status, name)
    select ('${space(0x0302)}' || lpad(to_hex(n), 12, '0'))::uuid, 'AGENCY', 'VERIFIED', 'Perf owner ' || n
      from generate_series(1, ${AGENCIES - 1}) n;
    set session_replication_role = default;`);
  for (let from = 1; from <= ROWS; from += BATCH) {
    for (const q of seed(from, Math.min(ROWS, from + BATCH - 1))) await runSql(q);
  }
  for (let from = 1; from <= ALL_UNITS; from += BATCH) {
    for (const q of seedUnits(from, Math.min(ALL_UNITS, from + BATCH - 1))) await runSql(q);
  }
  await runSql(seedDevelopmentRows);
  for (const t of [
    'listing_search_docs',
    'listing_read_models',
    'listing_public_codes',
    'listing_public_changes',
    'listing_search_developments',
    'listing_search_commissions',
  ]) {
    await adminQuery(`vacuum analyze ${t}`);
  }
  log.info(
    {
      rows: ROWS,
      units: UNITS,
      developments: DEVELOPMENTS + BIG_DEVELOPMENTS,
      bigDevelopmentUnits: BIG_UNITS,
      agencies: AGENCIES,
      seconds: Math.round((Date.now() - started) / 1000),
    },
    'website API rows loaded',
  );

  const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
    withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
  const custom = (includeOwn: boolean, locationIds: string[], minCommissionBp?: number) => ({
    includeOwn,
    includeNetwork: true,
    locationIds,
    propertyTypeIds: [],
    newBuilds: true,
    ...(minCommissionBp ? { minCommissionBp } : {}),
  });
  const sites: Record<SiteName, Parameters<typeof websites.createSite>[1]['inventoryFilters']> = {
    own: null,
    network: custom(true, [country]),
    narrow: custom(false, [city]),
    // S7-F6 review: network only, a 3 % minimum commission (a unit-level rule: the development is on the site when
    // one of its units passes it).
    commission: custom(false, [country], 300),
  };
  for (const [name, filters] of Object.entries(sites) as [SiteName, (typeof sites)[SiteName]][]) {
    const site = await as((ctx) =>
      websites.createSite(ctx, {
        name: `Perf ${name}`,
        domains: [`www.perf-${name}.example`],
        mode: 'WP_PLUGIN',
        inventoryPolicy: filters ? 'CUSTOM' : 'OWN_ONLY',
        inventoryFilters: filters,
        referencePrefix: 'PS',
        locales: ['en'],
        contact: null,
      }),
    );
    keys[name] = (
      await as((ctx) =>
        identity.createApiKey(ctx, {
          name,
          kind: 'SECRET',
          scopes: ['listings:read'],
          allowedOrigins: [],
          siteId: site.id,
        }),
      )
    ).secret;
  }
  app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allow,
    checks: {},
  });
}, 30 * 60_000);

afterAll(async () => {
  search.resetSearchBreaker();
  await app?.close();
  if (process.env.WEBSITE_PERF_KEEP !== '1') await cleanup().catch(() => undefined);
  await closeCache();
  await closeDb();
});

const p95 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.ceil(xs.length * 0.95) - 1] as number;
/** A sitemap cursor at public code `c` (the API's own encoding). */
const sitemapCursor = (c: string) => Buffer.from(JSON.stringify({ c })).toString('base64url');
/** A unit-table cursor at unit u (the API's own encoding: its public code). */
const unitsCursor = (u: number) =>
  Buffer.from(JSON.stringify({ u: `Y${u.toString(16).toUpperCase().padStart(7, '0')}` })).toString('base64url');
/** A developments cursor at development d (the API's own encoding: its public code). */
const developmentsCursor = (d: number) => Buffer.from(JSON.stringify({ d: devCode(d) })).toString('base64url');

it('[S7-03] each website API v2 endpoint answers within 3 queries and p95 < 150 ms at origin (scale seed)', async () => {
  const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
  // Row g belongs to the sites' agency when g is a multiple of AGENCIES; to the network otherwise.
  const networkRow = (i: number) => {
    const g = 1 + ((i * 7_919) % (ROWS - 1));
    return g % AGENCIES === 0 ? g + 1 : g;
  };
  const ownRow = (i: number) => AGENCIES * (1 + ((i * 104_729) % (Math.floor(ROWS / AGENCIES) - 1)));
  // S7-F6: a network development (not one in 50: the sites' agency's), and one of the sites' agency's.
  const networkDev = (i: number) => {
    const d = 1 + ((i * 7_919) % (DEVELOPMENTS - 1));
    return d % 50 === 0 ? d + 1 : d;
  };
  const ownDev = (i: number) => 50 * (1 + ((i * 104_729) % (Math.floor(DEVELOPMENTS / 50) - 1)));
  // A big development not the sites' agency's, and one of its units a share of the way down its table (by ref).
  const bigDev = (i: number) => {
    const d = DEVELOPMENTS + 1 + (i % BIG_DEVELOPMENTS);
    return d % 50 === 0 ? (d === DEVELOPMENTS + BIG_DEVELOPMENTS ? d - 1 : d + 1) : d;
  };
  const bigUnit = (i: number, share: number) =>
    UNITS + (bigDev(i) - DEVELOPMENTS - 1) * BIG_UNITS + 1 + Math.floor(BIG_UNITS * share);
  const endpoints: Record<string, { key: SiteName; url: (i: number) => string }> = {
    searchOwn: { key: 'own', url: (i) => `/v2/listings?priceMin=${(i % 50) * 1_000_000}&sort=price_asc` },
    searchNetwork: { key: 'network', url: (i) => `/v2/listings?bedsMin=${i % 4}&priceMin=${(i % 50) * 1_000_000}` },
    searchNarrow: { key: 'narrow', url: (i) => `/v2/listings?bedsMin=${i % 3}` },
    detailOwn: { key: 'own', url: (i) => `/v2/listings/PF${ownRow(i)}` },
    detailNetwork: { key: 'network', url: (i) => `/v2/listings/PS-${code(networkRow(i))}` },
    changesOwn: { key: 'own', url: () => `/v2/changes?since=${encodeURIComponent(since)}&limit=200` },
    changesNetwork: { key: 'network', url: () => `/v2/changes?since=${encodeURIComponent(since)}&limit=200` },
    sitemapOwn: { key: 'own', url: () => '/v2/sitemap?limit=500' },
    sitemapNetwork: { key: 'network', url: () => '/v2/sitemap?limit=500' },
    sitemapNarrow: { key: 'narrow', url: () => '/v2/sitemap?limit=500' },
    sitemapDeep: {
      key: 'network',
      // Five pages half-way down: warm after their first read, like the shared buffers of a staging-sized box (locally
      // the read models outgrow the 128 MB of shared buffers; a never-read page is logged as `sitemapColdPageMs`).
      url: (i) => `/v2/sitemap?limit=500&cursor=${sitemapCursor(code(Math.floor(ROWS * (0.5 + (i % 5) / 100))))}`,
    },
    // S7-F6: developments (grouped matches for own and narrow sites, the development-index walk network-wide).
    developmentsOwn: { key: 'own', url: () => '/v2/developments' },
    developmentsNetwork: { key: 'network', url: () => '/v2/developments' },
    developmentsNarrow: { key: 'narrow', url: () => '/v2/developments' },
    developmentsDeep: {
      key: 'network',
      url: (i) => `/v2/developments?cursor=${developmentsCursor(Math.floor(DEVELOPMENTS * (0.5 - (i % 5) / 100)))}`,
    },
    developmentNetwork: { key: 'network', url: (i) => `/v2/developments/PS-${devCode(networkDev(i))}` },
    // The agency's own development by its own reference (S7-F6 review: never the network form on its own site).
    developmentOwn: { key: 'own', url: (i) => `/v2/developments/PD${ownDev(i)}` },
    developmentsCommission: { key: 'commission', url: () => '/v2/developments' },
    // 2,000-unit developments: detail, the first unit page, a page deep in the table, and a full page of 100.
    developmentBig: { key: 'network', url: (i) => `/v2/developments/PS-${devCode(bigDev(i))}` },
    unitsBig: { key: 'network', url: (i) => `/v2/developments/PS-${devCode(bigDev(i))}/units?limit=24` },
    unitsBigDeep: {
      key: 'network',
      url: (i) =>
        `/v2/developments/PS-${devCode(bigDev(i))}/units?limit=24&cursor=${unitsCursor(bigUnit(i, 0.6 + (i % 5) / 100))}`,
    },
    unitsBigFull: { key: 'network', url: (i) => `/v2/developments/PS-${devCode(bigDev(i))}/units?limit=100` },
    unitsNetwork: { key: 'network', url: (i) => `/v2/developments/PS-${devCode(networkDev(i))}/units` },
    searchByDevelopment: {
      key: 'network',
      url: (i) => `/v2/listings?development=PS-${devCode(networkDev(i))}&kind=UNIT`,
    },
  };
  const get = (key: SiteName, url: string) => app.inject({ method: 'GET', url, headers: { 'x-api-key': keys[key] } });
  // Warm: pools, the site scopes and the network gate (cached in production too).
  for (const { key, url } of Object.values(endpoints)) for (let i = 0; i < 3; i++) await get(key, url(i));

  const report: Record<
    string,
    { p95Ms: number; coldP95Ms?: number; queries: number; coldQueries: number; items: number; bytes: number }
  > = {};
  for (const [name, { key, url }] of Object.entries(endpoints)) {
    const times: number[] = [];
    let bytes = 0;
    let items = 0;
    for (let i = 0; i < REQUESTS; i++) {
      const started = performance.now();
      const res = await get(key, url(100 + i));
      times.push(performance.now() - started);
      expect(res.statusCode, `${name} ${url(100 + i)}: ${res.body.slice(0, 200)}`).toBe(200);
      bytes = Math.max(bytes, res.body.length);
      items = Math.max(items, ((res.json() as { items?: unknown[] }).items ?? [1]).length);
    }
    await get(key, url(7));
    const queries = await countQueries(() => get(key, url(7)));
    websiteApi.resetWebsiteApiCaches();
    const coldQueries = await countQueries(() => get(key, url(8)));
    report[name] = { p95Ms: Math.round(p95(times) * 10) / 10, queries, coldQueries, items, bytes };
    // S7-F6: development endpoints also cold — no compiled owner identities, no resolved development references.
    if (/^(development|units|searchByDevelopment)/.test(name)) {
      const cold: number[] = [];
      for (let i = 0; i < REQUESTS; i++) {
        websiteApi.resetWebsiteApiCaches();
        search.resetDevelopmentCodes();
        const started = performance.now();
        expect((await get(key, url(200 + i))).statusCode, name).toBe(200);
        cold.push(performance.now() - started);
      }
      (report[name] as { coldP95Ms?: number }).coldP95Ms = Math.round(p95(cold) * 10) / 10;
    }
  }
  // A full unit-table page (100 units) stays within the feed budget gzipped (S7-F6 review).
  const full = await get('network', endpoints.unitsBigFull?.url(0) as string);
  expect((full.json() as { items: unknown[] }).items).toHaveLength(100);
  const unitsPageGzipBytes = gzipSync(full.body).length;
  expect(unitsPageGzipBytes).toBeLessThanOrEqual(150 * 1024);
  const coldStart = performance.now();
  expect(
    (await get('network', `/v2/sitemap?limit=500&cursor=${sitemapCursor(code(Math.floor(ROWS * 0.9)))}`)).statusCode,
  ).toBe(200);
  const sitemapColdPageMs = Math.round(performance.now() - coldStart);
  // Paging the change log from a cursor: the next page at a fixed cost.
  const first = (await get('network', endpoints.changesNetwork?.url(0) as string)).json() as { nextCursor: string };
  const started = performance.now();
  const next = await get('network', `/v2/changes?cursor=${first.nextCursor}&limit=200`);
  const changesPage2Ms = Math.round((performance.now() - started) * 10) / 10;
  expect(next.statusCode).toBe(200);
  log.info(
    { rows: ROWS, agencies: AGENCIES, report, changesPage2Ms, sitemapColdPageMs, unitsPageGzipBytes },
    'website API v2 at scale',
  );
  for (const [name, r] of Object.entries(report)) {
    if (r.coldP95Ms !== undefined) expect(r.coldP95Ms, `${name} cold`).toBeLessThan(P95_BUDGET_MS);
    expect(r.queries, name).toBeLessThanOrEqual(3);
    expect(r.coldQueries, name).toBeLessThanOrEqual(3);
    expect(r.items, name).toBeGreaterThan(0);
    expect(r.p95Ms, name).toBeLessThan(P95_BUDGET_MS);
  }
  expect(changesPage2Ms).toBeLessThan(P95_BUDGET_MS);
  // The public view is consistent: a sitemap reference opens as a detail.
  const map = (await get('network', '/v2/sitemap?limit=1')).json() as { items: { ref: string }[] };
  expect((await get('network', `/v2/listings/${map.items[0]?.ref}`)).statusCode).toBe(200);
}, 900_000);
