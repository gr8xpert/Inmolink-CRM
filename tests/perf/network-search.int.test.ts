import type { NetworkSearchBody } from '@inmolink/contracts';
import { type Ctx, type CtxRunner, withMemberCtx } from '@inmolink/core';
import * as agencies from '@inmolink/core/modules/agencies';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, countQueries, withSystem, withTenant } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureSearch, createMeiliEngine, type SearchEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * Network search at scale (S5-05 acceptance: API p95 < 300 ms on the scale seed). 40 owner agencies × 5,000 listings
 * (200,000 rows, the 1,000-agency seed's listing count, PLAN §4.1) — a mix of PRIVATE, SHARED and PUBLIC, ALL and
 * PREFERRED, statuses and commissions — with read models from the real builder and their documents in a Meilisearch
 * index; a verified viewer with five shared listings, preferred by ten of the owners, runs 200 varied searches through
 * `search.searchNetwork` exactly as the route does (two member transactions, the engine between them). Measured end to
 * end at the client; the engine alone at 500,000–2,000,000 documents is S5-02's check. The hot statements (give-to-get
 * count, card hydration) EXPLAIN without a Seq Scan on `properties` in < 20 ms under RLS. Deletes its rows again.
 */

const RUN = newId().slice(-8);
const log = createLogger({ service: 'perf', level: 'info' });
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const UID = `perf_network_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.network-search', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const runner =
  (m: Founder): CtxRunner =>
  (fn) =>
    as(m, fn);

const OWNERS = 40;
const PER_OWNER = 5_000;
const QUERIES = 200;
const P95_BUDGET_MS = 300;
const PREFIX = /^NW[0-9]{5}$/;

let owners: Founder[] = [];
let viewer: Founder;
let ids: { country: string; regions: string[]; types: string[] };
let engine: SearchEngine;
let network: string[] = [];

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
};

/** One owner's listings: 40 % PRIVATE, 40 % SHARED, 20 % PUBLIC; 80 % ACTIVE; a fifth PREFERRED; 5 % commission. */
async function seedListings(f: Founder, n: number, prefix: string, all: { status: string; visibility: string } | null) {
  const regions = sql.raw(`array[${ids.regions.map((r) => `'${r}'::uuid`).join(', ')}]`);
  const types = sql.raw(`array[${ids.types.map((t) => `'${t}'::uuid`).join(', ')}]`);
  await rows(sql`
    insert into properties (id, agency_id, owner_user_id, ref, status, visibility, share_scope, transaction_type,
                            price_cents, bedrooms, built_m2, energy_rating, commission_bp, split_bp, lat, lng,
                            property_type_id, location_id, country_id, region_id, created_at, updated_at)
    select gen_random_uuid(), ${f.agencyId}, ${f.userId}, ${prefix} || lpad(i::text, 5, '0'),
           coalesce(${all?.status ?? null}, case when i % 5 = 0 then 'DRAFT' else 'ACTIVE' end)::listing_status,
           coalesce(${all?.visibility ?? null},
             case when i % 5 < 2 then 'PRIVATE' when i % 5 < 4 then 'SHARED' else 'PUBLIC' end)::visibility,
           (case when i % 5 = 3 then 'PREFERRED' else 'ALL' end)::share_scope, 'SALE',
           15000000 + (i % 400)::bigint * 500000, i % 6, 60 + i % 300, 'C', 500, 5000,
           36 + (i % 100) * 0.05, -6 + (i % 80) * 0.05,
           (${types})[1 + i % ${ids.types.length}], (${regions})[1 + i % ${ids.regions.length}], ${ids.country},
           (${regions})[1 + i % ${ids.regions.length}],
           now() - make_interval(secs => ${n} - i), now() - make_interval(secs => ${n} - i)
      from generate_series(1, ${n}) as i`);
}

async function cleanUp(): Promise<void> {
  await system(async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    const targets = sql`(select id from properties where ref ~ ${PREFIX.source})`;
    await tx.execute(sql`delete from search_index_queue where target_id in ${targets}`);
    await tx.execute(sql`delete from listing_search_docs where target_id in ${targets}`);
    await tx.execute(sql`delete from listing_read_models where target_id in ${targets}`);
    await tx.execute(sql`delete from properties where ref ~ ${PREFIX.source}`);
  });
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  // A run killed before `afterAll` left its rows (S3-F3 pattern): they would slow every later suite.
  await cleanUp();
  const founders = await Promise.all(Array.from({ length: OWNERS + 1 }, () => createFounder()));
  viewer = founders[0] as Founder;
  owners = founders.slice(1);
  for (const f of [viewer, ...owners]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('perf-nw'),
      translations: tr(`Netperf ${RUN}`, 'netperf'),
    });
    const regions: string[] = [];
    for (let r = 0; r < 8; r++) {
      regions.push(
        await taxonomy.createLocation(tx, {
          level: 'REGION',
          parentId: country,
          code: code(`perf-nw-r${r}`),
          translations: tr(`Region ${r} ${RUN}`, `perf-nw-r${r}`),
        }),
      );
    }
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('perf-nw-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'perf-nw-g'),
    });
    const types: string[] = [];
    for (let t = 0; t < 6; t++) {
      types.push(
        await taxonomy.createPropertyType(tx, {
          groupId: group,
          key: code(`perf-nw-t${t}`),
          sort: 0,
          translations: tr(`Type ${t} ${RUN}`, `perf-nw-t${t}`),
        }),
      );
    }
    return { country, regions, types };
  });
  const started = Date.now();
  for (const f of owners) await seedListings(f, PER_OWNER, 'NW', null);
  await seedListings(viewer, 5, 'NW', { status: 'ACTIVE', visibility: 'SHARED' });
  // Ten owners prefer the viewer (their PREFERRED listings reach it); it prefers five of them.
  for (const f of owners.slice(0, 10))
    await as(f, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: viewer.agencyId }));
  for (const f of owners.slice(0, 5))
    await as(viewer, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: f.agencyId }));
  await system((tx) => tx.execute(sql`analyze properties`));

  // Read models of everything on the network, built as the worker builds them; their documents into the index.
  network = (
    await rows<{ id: string }>(
      sql`select id from properties where ref ~ ${PREFIX.source} and visibility <> 'PRIVATE' and status = 'ACTIVE'`,
    )
  ).map((r) => r.id);
  for (let i = 0; i < network.length; i += 2_000) {
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', network.slice(i, i + 2_000)));
  }
  engine = createMeiliEngine({
    url: process.env.MEILI_URL as string,
    apiKey: process.env.MEILI_MASTER_KEY as string,
    timeoutMs: 120_000,
  });
  configureSearch(engine);
  search.configureSearchIndex({ uid: UID, scope: [] });
  await search.ensureListingsIndex(engine, search.listingsIndex(UID));
  let last: { uid: number } | null = null;
  for (let i = 0; i < network.length; i += 5_000) {
    const { docs } = await system((tx) => search.indexDocsFor(tx, network.slice(i, i + 5_000)));
    last = await engine.upsert(UID, docs);
  }
  if (last) await engine.waitForTask(last, { timeoutMs: 1_800_000 });
  await system((tx) => tx.execute(sql`analyze listing_read_models`));
  search.configureNetworkSearch({ giveToGetMinShared: 5 });
  log.info(
    { listings: OWNERS * PER_OWNER, onNetwork: network.length, seconds: Math.round((Date.now() - started) / 1000) },
    'network search perf data loaded',
  );
}, 3_600_000);

afterAll(async () => {
  search.configureNetworkSearch({});
  await engine?.dropIndex(UID);
  if (owners.length) await cleanUp();
  await closeDb();
}, 600_000);

function body(i: number): NetworkSearchBody {
  const region = ids.regions[i % ids.regions.length] as string;
  const type = ids.types[i % ids.types.length] as string;
  switch (i % 5) {
    case 0:
      return { limit: 24 };
    case 1:
      return { locationIds: [region], bedsMin: 2, priceMinCents: 20_000_000, priceMaxCents: 120_000_000, limit: 24 };
    case 2:
      return { propertyTypeIds: [type], sort: 'price_asc', limit: 24 };
    case 3:
      return { preferredOnly: true, locationIds: [region], sort: 'price_desc', limit: 24 };
    default:
      // map view: one full page of pins in a box
      return { geoBox: { north: 39, south: 36, west: -6, east: -2 }, limit: 50 };
  }
}

it('[S5-05] API p95 < 300 ms on the scale seed (member context and engine included)', async () => {
  const first = await search.searchNetwork(runner(viewer), body(0));
  expect(first.status).toBe('OK');
  expect(first.status === 'OK' && first.items.length).toBe(24);
  // Warm-up (connections, caches), then the measured runs.
  for (let i = 0; i < 10; i++) await search.searchNetwork(runner(viewer), body(i));
  const times: number[] = [];
  let results = 0;
  for (let i = 0; i < QUERIES; i++) {
    const started = performance.now();
    const res = await search.searchNetwork(runner(viewer), body(i));
    times.push(performance.now() - started);
    if (res.status === 'OK') results += res.items.length;
  }
  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  const statements = await countQueries(() => search.searchNetwork(runner(viewer), body(1)));
  log.info(
    { p50: Math.round(p50), p95: Math.round(p95), max: Math.round(Math.max(...times)), results, statements },
    'S5-05 network search on 200,000 listings',
  );
  expect(results).toBeGreaterThan(QUERIES * 10);
  expect(statements).toBeLessThanOrEqual(10);
  expect(p95).toBeLessThan(P95_BUDGET_MS);
}, 600_000);

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; Plans?: PlanNode[] };
const seqScansOn = (node: unknown, table: string): string[] => {
  const n = node as PlanNode;
  const here = n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table ? [n['Node Type']] : [];
  return [...here, ...(n.Plans ?? []).flatMap((c) => seqScansOn(c, table))];
};

it('[S5-05] EXPLAIN on scale: give-to-get count and card hydration read by index under RLS, < 20 ms', async () => {
  const page = network
    .slice(0, 24)
    .map((id) => `'${id}'::uuid`)
    .join(', ');
  const statements: Record<string, string> = {
    'give-to-get count': `select count(*)::int as n from (select 1 from properties
       where agency_id = '${owners[0]?.agencyId}' and visibility <> 'PRIVATE' and status = 'ACTIVE'
         and deleted_at is null and network_hidden_at is null limit 5) s`,
    // search repo `networkCards` (S6-F3): the viewer's locale and the fallback first, another only for ids missing
    'card hydration': `with pick as (
        select distinct on (m.target_id) m.target_id, m.kind, m.card from listing_read_models m
         where m.target_id = any(array[${page}]) and m.locale in ('en', 'es')
         order by m.target_id, (m.locale = 'en') desc)
      select target_id, kind, card from pick
      union all
      select o.target_id, o.kind, o.card from unnest(array[${page}]) as t(id)
        cross join lateral (select m.target_id, m.kind, m.card from listing_read_models m
          where m.target_id = t.id order by m.locale limit 1) o
       where not exists (select 1 from pick p where p.target_id = t.id)`,
    'listing terms': `select id, agency_id, price_cents, commission_bp, split_bp from properties
       where id = any(array[${page}]) and agency_id <> '${viewer.agencyId}'`,
  };
  const report: Record<string, string> = {};
  for (const [name, statement] of Object.entries(statements)) {
    // The count runs as its owner (its own rows); the others as the viewer reading the network.
    const who = name === 'give-to-get count' ? (owners[0] as Founder) : viewer;
    const plan = await withTenant({ agencyId: who.agencyId, userId: who.userId }, async (tx) => {
      await tx.execute(sql.raw(statement));
      const res = await tx.execute<{ 'QUERY PLAN': unknown }>(
        sql.raw(`explain (analyze, buffers, format json) ${statement}`),
      );
      return res.rows[0]?.['QUERY PLAN'] as [{ Plan: unknown; 'Execution Time': number }];
    });
    const ms = plan[0]['Execution Time'];
    const index = /"Index Name":"([a-z_]+)"/.exec(JSON.stringify(plan[0].Plan))?.[1] ?? 'none';
    report[name] = `${index} ${ms.toFixed(2)} ms`;
    expect(seqScansOn(plan[0].Plan, 'properties'), name).toEqual([]);
    expect(seqScansOn(plan[0].Plan, 'listing_read_models'), name).toEqual([]);
    expect(ms, name).toBeLessThan(20);
  }
  log.info(report, 'S5-05 network search plans on 200,000 listings');
});
