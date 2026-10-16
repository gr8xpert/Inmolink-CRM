import { ListListingsQuery, StartListingBulkBody } from '@inmolink/contracts';
import { type Ctx, withMemberCtx } from '@inmolink/core';
import * as properties from '@inmolink/core/modules/properties';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, countQueries, withSystem, withTenant } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * Listing list and bulk actions at agency scale (S3-07 acceptance). An agency with 5,000 listings in a table of
 * 200,000 (39 more agencies of 5,000: the listing count of the 1,000-agency scale seed, PLAN §4.1 — the scale
 * seeder has no listings yet): every sort and the common filters answer in ≤ 10 statements with p95 < 300 ms,
 * member context included, and the list statements EXPLAIN without a Seq Scan in < 20 ms as `app_user` under RLS. A bulk status change of 1,000 listings runs as the worker runs it
 * (`properties.runBulkAction`) and emits one `properties.listing.updated` per listing. In the `perf` project: it
 * runs alone, and it deletes its listings again (the shared test database keeps every run's rows).
 */

const RUN = newId().slice(-8);
const log = createLogger({ service: 'perf', level: 'info' });
const silent = createLogger({ service: 'perf', level: 'silent' });
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.listing-list-bulk', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

/** Agencies besides the measured one and the bulk one: 39 × 5,000 listings. */
const OTHERS = 39;
let agencies: Founder[] = [];
let ids: { location: string; type: string };

async function seedListings(f: Founder, n: number, prefix: string): Promise<string[]> {
  const res = await rows<{ id: string }>(sql`
    insert into properties (id, agency_id, owner_user_id, ref, status, transaction_type, price_cents, bedrooms,
                            energy_rating, property_type_id, location_id, country_id, created_at, updated_at)
    select gen_random_uuid(), ${f.agencyId}, ${f.userId}, ${prefix} || lpad(i::text, 5, '0'), 'DRAFT', 'SALE',
           case when i % 10 = 0 then null else 10000000 + i::bigint * 100000 end, i % 6, 'C',
           ${ids.type}, ${ids.location}, ${ids.location},
           now() - make_interval(secs => ${n} - i), now() - make_interval(secs => ${n} - i)
      from generate_series(1, ${n}) as i
    returning id`);
  return res.map((r) => r.id);
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
};

beforeAll(async () => {
  await setupTestDb('worker');
  agencies = await Promise.all(Array.from({ length: OTHERS + 2 }, () => createFounder()));
  await Promise.all(agencies.slice(0, 2).map((f) => setAgencyStatus(f.agencyId, 'VERIFIED')));
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('perf-ll'),
      translations: tr(`Perfland ${RUN}`, 'perfland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('perf-ll-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'perf-ll-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('perf-ll-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'perf-ll-villa'),
    });
    return { location, type };
  });
}, 180_000);

afterAll(async () => {
  const list = agencies.map((a) => a.agencyId);
  if (list.length > 0) {
    await system(async (tx) => {
      const inList = sql.join(
        list.map((a) => sql`${a}::uuid`),
        sql`, `,
      );
      await tx.execute(sql`delete from listing_bulk_actions where agency_id in (${inList})`);
      await tx.execute(sql`delete from properties where agency_id in (${inList})`);
    });
  }
  await closeDb();
}, 180_000);

it('[S3-07] List endpoint ≤ 10 queries and p95 < 300 ms for an agency with 5,000 listings', async () => {
  const big = agencies[0] as Founder;
  await seedListings(big, 5_000, 'BG');
  for (const other of agencies.slice(2)) await seedListings(other, 5_000, 'OT');
  await system((tx) => tx.execute(sql`analyze properties`));
  const [{ n } = { n: 0 }] = await rows<{ n: number }>(sql`select count(*)::int as n from properties`);
  expect(n).toBeGreaterThanOrEqual(200_000);

  const list = (q: Record<string, unknown>) =>
    as(big, (ctx) => properties.listListings(ctx, ListListingsQuery.parse(q)));
  const first = await list({ limit: 50, sort: 'price_desc' });
  const scenarios: Record<string, unknown>[] = [
    { limit: 50 },
    { limit: 100, sort: 'oldest' },
    { limit: 50, sort: 'updated' },
    { limit: 50, sort: 'price_asc' },
    { limit: 50, sort: 'price_desc' },
    { limit: 50, sort: 'price_desc', cursor: first.nextCursor },
    { limit: 50, status: 'DRAFT', bedroomsMin: 3 },
    { limit: 50, priceMin: 50_000_000, priceMax: 60_000_000, sort: 'price_asc' },
    { limit: 50, q: 'BG04', mine: 'true' },
    { limit: 50, tag: 'nothing-has-this' },
    // S3-F6: a location's whole subtree (the country column), newest first
    { limit: 50, locationId: ids.location },
  ];
  const times: number[] = [];
  const perScenario: Record<string, number> = {};
  for (const q of scenarios) {
    const key = JSON.stringify(q).slice(0, 60);
    expect(await countQueries(() => list(q)), key).toBeLessThanOrEqual(10);
    const mine: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const page = await list(q);
      mine.push(performance.now() - t0);
      if (!q.tag) expect(page.items.length, key).toBeGreaterThan(0);
    }
    times.push(...mine);
    perScenario[key] = Math.round(percentile(mine, 95) * 10) / 10;
  }
  const p95 = percentile(times, 95);
  log.info({ p50: percentile(times, 50), p95, runs: times.length, perScenario }, 'S3-07 listing list, 5,000 listings');
  expect(p95).toBeLessThan(300);
});

it('[S3-07] Bulk action on 1,000 listings completes in a job and emits one event per listing', async () => {
  const team = agencies[1] as Founder;
  const listingIds = await seedListings(team, 1_000, 'BK');
  const bulk = await as(team, (ctx) =>
    properties.startBulkAction(
      ctx,
      StartListingBulkBody.parse({ action: { type: 'STATUS', status: 'ACTIVE' }, target: { ids: listingIds } }),
    ),
  );
  const requested = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
    where type = 'properties.bulkAction.requested' and payload->>'bulkActionId' = ${bulk.id}`);
  expect(requested[0]?.n).toBe(1);

  const progress: unknown[] = [];
  const rss: number[] = [];
  const t0 = performance.now();
  await properties.propertiesJobs.runBulkAction.spec.run(
    { bulkActionId: bulk.id, agencyId: team.agencyId, userId: team.userId },
    {
      log: silent,
      jobId: newId(),
      attempt: 1,
      progress: async (v) => {
        progress.push(v);
        rss.push(process.memoryUsage().rss);
      },
      signal: new AbortController().signal,
    },
  );
  const ms = Math.round(performance.now() - t0);
  log.info({ ms, chunks: progress.length, peakRssMb: Math.round(Math.max(...rss) / 2 ** 20) }, 'S3-07 bulk 1,000');
  expect(progress.at(-1)).toEqual({ processed: 1_000, total: 1_000 });

  const done = await as(team, (ctx) => properties.getBulkAction(ctx, bulk.id));
  expect(done).toMatchObject({ state: 'DONE', processed: 1_000, succeeded: 1_000, unchanged: 0, failed: 0 });
  const perListing = await rows<{ type: string; listings: number; events: number }>(sql`
    select type, count(distinct payload->>'listingId')::int as listings, count(*)::int as events
      from outbox_events
     where agency_id = ${team.agencyId} and type like 'properties.listing.%'
     group by type order by type`);
  expect(perListing).toEqual([
    { type: 'properties.listing.statusChanged', listings: 1_000, events: 1_000 },
    { type: 'properties.listing.updated', listings: 1_000, events: 1_000 },
  ]);
  const [state] = await rows<{ active: number; history: number }>(sql`
    select count(*) filter (where status = 'ACTIVE')::int as active,
           (select count(*)::int from property_status_histories h
             where h.agency_id = ${team.agencyId} and h.to_status = 'ACTIVE') as history
      from properties where agency_id = ${team.agencyId}`);
  expect(state).toEqual({ active: 1_000, history: 1_000 });
});

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; Plans?: PlanNode[] };
/** Every Seq Scan of `table` anywhere in the plan tree. */
const seqScansOn = (node: unknown, table: string): string[] => {
  const n = node as PlanNode;
  const here = n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table ? [n['Node Type']] : [];
  return [...here, ...(n.Plans ?? []).flatMap((c) => seqScansOn(c, table))];
};

/** The list statements as the repo builds them (`repo.listOwn`), one per sort, plus the tag filter. */
const PLANS: Record<string, string> = {
  newest: `order by date_trunc('milliseconds', created_at, 'UTC') desc, id desc`,
  updated: `order by date_trunc('milliseconds', updated_at, 'UTC') desc, id desc`,
  price_asc: 'order by price_cents asc nulls last, id asc',
  price_desc: 'order by price_cents desc nulls last, id desc nulls last',
};

it('[S3-07] EXPLAIN on scale: every list order walks its index, no Seq Scan, < 20 ms under RLS', async () => {
  const big = agencies[0] as Founder;
  const statements = Object.entries(PLANS).map(([name, order]) => [
    name,
    `select id, ref, status, price_cents from properties
      where agency_id = '${big.agencyId}' and deleted_at is null ${order} limit 51`,
  ]);
  statements.push([
    'tag',
    `select id, ref from properties
      where agency_id = '${big.agencyId}' and deleted_at is null
        and exists (select 1 from property_tags t where t.property_id = properties.id and t.tag = 'golf')
      order by date_trunc('milliseconds', created_at, 'UTC') desc, id desc limit 51`,
  ]);
  // S3-F6: a rare subtree — one of the agency's 5,000 listings in this region — reads its matches only, by index
  const region = await system((tx) =>
    taxonomy.createLocation(tx, { level: 'REGION', parentId: ids.location, translations: tr(`Rare ${RUN}`, 'rare') }),
  );
  await rows(sql`update properties set region_id = ${region}
    where id = (select id from properties where agency_id = ${big.agencyId} order by id limit 1)`);
  await system((tx) => tx.execute(sql`analyze properties`));
  for (const [name, order] of [
    ['region subtree, newest', `order by date_trunc('milliseconds', created_at, 'UTC') desc, id desc`],
    ['region subtree, price', 'order by price_cents desc nulls last, id desc'],
  ]) {
    statements.push([
      name as string,
      `select id, ref from properties
        where agency_id = '${big.agencyId}' and deleted_at is null and region_id = '${region}' ${order} limit 51`,
    ]);
  }
  const report: Record<string, string> = {};
  for (const [name, statement] of statements) {
    const plan = await withTenant({ agencyId: big.agencyId, userId: big.userId }, async (tx) => {
      await tx.execute(sql.raw(statement as string)); // warm
      const res = await tx.execute<{ 'QUERY PLAN': unknown }>(
        sql.raw(`explain (analyze, buffers, format json) ${statement}`),
      );
      return res.rows[0]?.['QUERY PLAN'] as [{ Plan: unknown; 'Execution Time': number }];
    });
    const text = JSON.stringify(plan[0].Plan);
    const ms = plan[0]['Execution Time'];
    const index = /"Index Name":"(properties_[a-z_]+)"/.exec(text)?.[1] ?? 'none';
    report[name as string] = `${index} ${ms.toFixed(2)} ms`;
    expect(seqScansOn(plan[0].Plan, 'properties'), name).toEqual([]);
    expect(ms, name).toBeLessThan(20);
  }
  log.info(report, 'S3-07 list plans on 200,000 listings');
});
