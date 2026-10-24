import { type Ctx, withMemberCtx } from '@inmolink/core';
import * as network from '@inmolink/core/modules/network';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, type Tx, withSystem, withTenant } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureSearch, createMeiliEngine, type SearchEngine } from '@inmolink/platform/search';
import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardQuery, matchingSubscribersQuery, postById } from '../../packages/core/src/modules/network/repo';

/**
 * Network board at scale (S11-05): 250 verified agencies × 160 listings (40,000 rows, four in five of them on the network and in
 * a Meilisearch index built from the real read models), 48 board subscriptions (12,000) and 50 posts (12,500) per agency.
 * A buyer request is matched by the worker over the search engine and each matching agency notified once; a post's
 * subscriber fan-out walks every subscription; the board's page 2 is explained under RLS. Deletes its rows again.
 */

const RUN = newId().slice(-8);
const log = createLogger({ service: 'perf', level: 'info' });
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const UID = `perf_netboard_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('perf.network-board', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

const AGENCIES = 250;
const PER_AGENCY = 160;
const SUBSCRIPTIONS_PER_AGENCY = 48;
const POSTS_PER_AGENCY = 50;
const PREFIX = /^NBRD[0-9]{5}$/;
const MATCH_BUDGET_MS = 5_000;
const FANOUT_BUDGET_MS = 3_000;
const SQL_BUDGET_MS = 20;

const agencies: Founder[] = [];
let poster: Founder;
let ids: { country: string; regions: string[]; types: string[] };
let engine: SearchEngine;

async function seedListings(f: Founder) {
  const regions = sql.raw(`array[${ids.regions.map((r) => `'${r}'::uuid`).join(', ')}]`);
  const types = sql.raw(`array[${ids.types.map((t) => `'${t}'::uuid`).join(', ')}]`);
  await rows(sql`
    insert into properties (id, agency_id, owner_user_id, ref, status, visibility, share_scope, transaction_type,
                            price_cents, bedrooms, built_m2, energy_rating, commission_bp, split_bp, lat, lng,
                            property_type_id, location_id, country_id, region_id, created_at, updated_at)
    select gen_random_uuid(), ${f.agencyId}, ${f.userId}, 'NBRD' || lpad(i::text, 5, '0'), 'ACTIVE'::listing_status,
           (case when i % 5 = 0 then 'PRIVATE' else 'SHARED' end)::visibility, 'ALL'::share_scope, 'SALE',
           15000000 + (i % 400)::bigint * 500000, i % 6, 60 + i % 300, 'C', 500, 5000,
           36 + (i % 100) * 0.05, -6 + (i % 80) * 0.05,
           (${types})[1 + i % ${ids.types.length}], (${regions})[1 + i % ${ids.regions.length}], ${ids.country},
           (${regions})[1 + i % ${ids.regions.length}],
           now() - make_interval(secs => ${PER_AGENCY} - i), now() - make_interval(secs => ${PER_AGENCY} - i)
      from generate_series(1, ${PER_AGENCY}) as i`);
}

/** 48 subscriptions per agency, some of them matching the test's buyer request (region 0, villas, in budget). */
async function seedBoard(f: Founder) {
  const regions = sql.raw(`array[${ids.regions.map((r) => `'${r}'::uuid`).join(', ')}]`);
  await rows(sql`
    insert into network_subscriptions (agency_id, id, user_id, name, kinds, location_ids, price_max_cents)
    select ${f.agencyId}, gen_random_uuid(), ${f.userId}, 'S' || i,
           case when i % 3 = 0 then null else array['BUYER_REQUEST']::text[] end,
           array[(${regions})[1 + i % ${ids.regions.length}]],
           case when i % 4 = 0 then null else 10000000 + i * 2000000 end
      from generate_series(1, ${SUBSCRIPTIONS_PER_AGENCY}) as i`);
  await rows(sql`
    insert into network_posts (agency_id, id, kind, title, body, created_at, expires_at)
    select ${f.agencyId}, gen_random_uuid(),
           (array['BUYER_REQUEST', 'PROPERTY_OFFER', 'DISTRESSED', 'DEVELOPER_ANNOUNCEMENT'])[1 + i % 4],
           'Post ' || i, 'Text of post ' || i, now() - make_interval(mins => i * 7),
           now() + interval '30 days' - make_interval(mins => i * 7)
      from generate_series(1, ${POSTS_PER_AGENCY}) as i`);
}

async function cleanUp(): Promise<void> {
  await system(async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    const targets = sql`(select id from properties where ref ~ ${PREFIX.source})`;
    await tx.execute(sql`delete from search_index_queue where target_id in ${targets}`);
    await tx.execute(sql`delete from listing_search_docs where target_id in ${targets}`);
    await tx.execute(sql`delete from listing_read_models where target_id in ${targets}`);
    await tx.execute(sql`delete from read_model_queue where target_id in ${targets}`);
    await tx.execute(sql`delete from properties where ref ~ ${PREFIX.source}`);
    if (agencies.length > 0) {
      const list = sql.join(
        agencies.map((a) => sql`${a.agencyId}::uuid`),
        sql`, `,
      );
      await tx.execute(sql`delete from network_subscriptions where agency_id in (${list})`);
      await tx.execute(sql`delete from network_post_authors where agency_id in (${list})`);
      await tx.execute(sql`delete from network_posts where agency_id in (${list})`);
      await tx.execute(sql`delete from notifications where agency_id in (${list})`);
    }
  });
}

const timed = async <T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> => {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
};

class Rollback extends Error {}

/** EXPLAIN (ANALYZE, BUFFERS) of `q`, five times after a warm-up, in a rolled-back transaction; the fastest run. */
async function explain(
  run: (fn: (tx: Tx) => Promise<string>) => Promise<string>,
  q: (tx: Tx) => SQL | { getSQL(): SQL },
) {
  const once = () =>
    run(async (tx) => {
      const res = await tx.execute(sql`explain (analyze, buffers) ${q(tx)}`);
      return (res.rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0])).join('\n');
    });
  await once();
  const out: { plan: string; ms: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const plan = await once();
    out.push({ plan, ms: Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]) });
  }
  return out.reduce((x, y) => (x.ms <= y.ms ? x : y));
}

const rolledBack =
  (open: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>) =>
  (fn: (tx: Tx) => Promise<string>): Promise<string> =>
    open(async (tx) => {
      const plan = await fn(tx);
      throw Object.assign(new Rollback(), { plan });
    }).catch((err: unknown) => {
      if (err instanceof Rollback) return (err as Rollback & { plan: string }).plan;
      throw err;
    });

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  // A run killed before `afterAll` left its listings (S3-F3 pattern).
  await cleanUp();
  const started = Date.now();
  for (let i = 0; i < AGENCIES + 1; i += 20) {
    agencies.push(
      ...(await Promise.all(Array.from({ length: Math.min(20, AGENCIES + 1 - i) }, () => createFounder()))),
    );
  }
  for (const f of agencies) await setAgencyStatus(f.agencyId, 'VERIFIED');
  poster = agencies[0] as Founder;
  ids = await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('perf-nb'),
      translations: tr(`Boardperf ${RUN}`, 'boardperf'),
    });
    const regions: string[] = [];
    for (let r = 0; r < 8; r++) {
      regions.push(
        await taxonomy.createLocation(tx, {
          level: 'REGION',
          parentId: country,
          code: code(`perf-nb-r${r}`),
          translations: tr(`Region ${r} ${RUN}`, `perf-nb-r${r}`),
        }),
      );
    }
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('perf-nb-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'perf-nb-g'),
    });
    const types: string[] = [];
    for (let t = 0; t < 6; t++) {
      types.push(
        await taxonomy.createPropertyType(tx, {
          groupId: group,
          key: code(`perf-nb-t${t}`),
          sort: 0,
          translations: tr(`Type ${t} ${RUN}`, `perf-nb-t${t}`),
        }),
      );
    }
    return { country, regions, types };
  });
  for (const f of agencies.slice(1)) await seedListings(f);
  for (const f of agencies) await seedBoard(f);
  await system(async (tx) => {
    await tx.execute(sql`analyze properties`);
    await tx.execute(sql`analyze network_subscriptions`);
    await tx.execute(sql`analyze network_posts`);
  });
  const onNetwork = (
    await rows<{ id: string }>(sql`select id from properties where ref ~ ${PREFIX.source} and visibility <> 'PRIVATE'`)
  ).map((r) => r.id);
  for (let i = 0; i < onNetwork.length; i += 2_000) {
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', onNetwork.slice(i, i + 2_000)));
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
  for (let i = 0; i < onNetwork.length; i += 5_000) {
    const { docs } = await system((tx) => search.indexDocsFor(tx, onNetwork.slice(i, i + 5_000)));
    last = await engine.upsert(UID, docs);
  }
  if (last) await engine.waitForTask(last, { timeoutMs: 1_800_000 });
  log.info(
    {
      agencies: AGENCIES,
      listings: AGENCIES * PER_AGENCY,
      indexed: onNetwork.length,
      seconds: Math.round((Date.now() - started) / 1000),
    },
    'network board perf data loaded',
  );
}, 3_600_000);

afterAll(async () => {
  await engine?.dropIndex(UID);
  await cleanUp();
  await closeDb();
}, 600_000);

const buyerRequest = () => ({
  kind: 'BUYER_REQUEST' as const,
  title: `Villa wanted ${RUN}`,
  body: 'Client relocating, ready to buy.',
  criteria: {
    transactionType: 'SALE' as const,
    propertyTypeIds: [ids.types[0] as string],
    locationIds: [ids.regions[0] as string],
    priceMinCents: 20_000_000,
    priceMaxCents: 200_000_000,
  },
});

describe('network board at scale', () => {
  it('[S11-05] a buyer request matching listings of more than 200 agencies notifies all of them (one job < 5 s)', async () => {
    const { post } = await as(poster, (ctx) => network.createPost(ctx, buyerRequest()));
    const engineCall = await timed(() =>
      search.matchListingOwners(
        {
          transactionType: 'SALE',
          propertyTypeIds: [ids.types[0] as string],
          locationIds: [ids.regions[0] as string],
          priceMinCents: 20_000_000,
          priceMaxCents: 200_000_000,
        },
        { excludeAgencyId: poster.agencyId, perAgency: 10 },
      ),
    );
    const job = await timed(() => network.matchBuyerRequest(post.id));
    const again = await network.matchBuyerRequest(post.id);
    const told = await rows<{ agency_id: string; n: number }>(sql`
      select agency_id, count(*)::int as n from notifications
       where type = 'NETWORK_MATCH' and source_key = ${`network.match:${post.id}`} group by agency_id`);
    log.info(
      {
        engineMs: Math.round(engineCall.ms),
        jobMs: Math.round(job.ms),
        matchedAgencies: engineCall.result.owners.length,
        notified: job.result.notified,
      },
      'buyer request matching',
    );
    expect(engineCall.result.truncated).toBe(false);
    // every owner but the poster (it has no listings): more than the engine's 200-value facet
    expect(engineCall.result.owners.length).toBe(AGENCIES);
    expect(job.result.agencies).toBe(AGENCIES);
    expect(told).toHaveLength(AGENCIES);
    expect(told.every((t) => t.n === 1)).toBe(true);
    expect(told.map((t) => t.agency_id)).not.toContain(poster.agencyId);
    expect(again.notified).toBe(0);
    expect(job.ms).toBeLessThan(MATCH_BUDGET_MS);
  });

  it('[S11-05] subscriber fan-out over 12,000 subscriptions < 3 s; its batch of 100 agencies < 20 ms', async () => {
    const { post } = await as(poster, (ctx) => network.createPost(ctx, buyerRequest()));
    const job = await timed(() => network.notifySubscribers(post.id));
    log.info({ fanoutMs: Math.round(job.ms), notified: job.result.notified }, 'subscriber fan-out');
    expect(job.result.notified).toBeGreaterThanOrEqual(AGENCIES - 10);
    expect(job.ms).toBeLessThan(FANOUT_BUDGET_MS);
    const row = await system((tx) => postById(tx, post.id));
    const best = await explain(rolledBack(system), () =>
      matchingSubscribersQuery(row as NonNullable<typeof row>, null, network.SUBSCRIBER_AGENCY_BATCH, 50_000),
    );
    log.info({ ms: best.ms }, `subscriptions page plan:\n${best.plan}`);
    // The walk reads every subscription once per post by design (S11-05 decision: an unset filter matches everything,
    // so no index can narrow it); on a fresh CI database the planner reads the 12k rows with a Seq Scan (CI 860eb87,
    // 4.4 ms), elsewhere by the primary key. The budget is the time, not the plan; revisit past ~100k subscriptions.
    expect(best.ms).toBeLessThan(SQL_BUDGET_MS);
  });

  it('[S11-05] the board, page 2 under RLS: index-ordered, < 20 ms', async () => {
    const viewer = agencies[1] as Founder;
    const member = rolledBack(<T>(fn: (tx: Tx) => Promise<T>) =>
      withTenant({ agencyId: viewer.agencyId, userId: viewer.userId }, fn),
    );
    const first = await as(viewer, (ctx) => network.listPosts(ctx, { limit: 25 }));
    expect(first.items).toHaveLength(25);
    const page2 = await as(viewer, (ctx) => network.listPosts(ctx, { limit: 25, cursor: first.nextCursor as string }));
    expect(page2.items).toHaveLength(25);
    const last = first.items.at(-1) as { id: string };
    const [stamp] = await rows<{ us: string }>(sql`
      select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as us
        from network_posts where id = ${last.id}`);
    const cursor = { at: new Date(stamp?.us as string), id: last.id, atUs: stamp?.us as string };
    for (const kind of [undefined, 'BUYER_REQUEST']) {
      const best = await explain(member, (tx) => boardQuery(tx, { kind, limit: 25, cursor }));
      log.info({ kind, ms: best.ms }, `board page 2 plan:\n${best.plan}`);
      expect(best.plan).not.toMatch(/Seq Scan on network_posts/);
      expect(best.plan).not.toMatch(/Sort/);
      expect(best.ms).toBeLessThan(SQL_BUDGET_MS);
    }
  });
});
