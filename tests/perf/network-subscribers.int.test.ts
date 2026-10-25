import { closeDb, type Tx, withSystem } from '@inmolink/db';
import { adminQuery, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SUBSCRIBER_BATCH } from '../../packages/core/src/modules/network/matching';
import {
  matchingSubscribers,
  matchingSubscribersQuery,
  type PostRow,
  type SubscriberRow,
  withWalkPlan,
} from '../../packages/core/src/modules/network/repo';

/**
 * The network subscriber walk at scale (S12-F3): `NETWORK_SUBSCRIPTION_ROWS` subscriptions (default 1,000,000 — PLAN
 * §1's 5,000 agencies × 20 members × 10) of 5,000 agencies, with filters set the way members set them: kinds (two in
 * five unset), transaction type (half unset), property types (three in five unset), locations (15 % anywhere, 5 % the
 * country, else regions, cities or areas of a 2,550-place tree), price bounds (about half unset). Their terms are
 * written by the migration's backfill statement (the trigger is the int test's), then VACUUMed all-visible. Each
 * post shape's batch (`SUBSCRIBER_BATCH` members) is explained at several walk positions: index-only scans of
 * `network_subscription_terms_walk_idx`, no Seq Scan, no hash, < 20 ms (fastest of five after a warm-up). One post's
 * whole walk is compared with the S11-05 predicate over `network_subscriptions` itself. Deletes its rows again.
 */

const log = createLogger({ service: 'perf', level: 'info' });
const ROWS = Number(process.env.NETWORK_SUBSCRIPTION_ROWS ?? 1_000_000);
const AGENCIES = 5_000;
const SQL_BUDGET_MS = 20;
const BATCH = 100_000;
/** This test's id spaces: agencies `0195f0a5-0601-…`, members `…-0602-…`, places and types `…-0603-…`. */
const space = (s: number) => `0195f0a5-${s.toString(16).padStart(4, '0')}-7000-8000-`;
const id = (s: number, n: number) => `${space(s)}${n.toString(16).padStart(12, '0')}`;
const idSql = (s: number, n: string) => `('${space(s)}' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const place = (n: number) => id(0x0603, n);
/** Places: the country 1, regions 2–51, cities 52–551, areas 552–2551; property types 2601–2620. */
const h = (k: number, m: number) => `(abs(hashint8(g::bigint * 7919 + ${k})) % ${m})::int`;

const seed = (from: number, to: number) => `
  set session_replication_role = replica;
  insert into network_subscriptions (agency_id, id, user_id, name, kinds, transaction_type, property_type_ids,
                                     location_ids, price_min_cents, price_max_cents)
  select ${idSql(0x0601, `1 + g % ${AGENCIES}`)}, gen_random_uuid(),
         ${idSql(0x0602, `(g % ${AGENCIES}) * 20 + ${h(1, 20)}`)}, 'S' || g,
         case ${h(2, 5)} when 0 then null when 1 then null when 2 then array['BUYER_REQUEST']
              when 3 then array['PROPERTY_OFFER', 'DISTRESSED'] else array['DEVELOPER_ANNOUNCEMENT'] end,
         case ${h(3, 4)} when 0 then null when 1 then null when 2 then 'SALE' else 'RENT_LONG_TERM' end,
         case when ${h(4, 10)} < 6 then null
              else array[${idSql(0x0603, `2601 + ${h(5, 20)}`)}, ${idSql(0x0603, `2601 + ${h(6, 20)}`)}] end,
         case when l < 3 then null
              when l = 3 then array[${idSql(0x0603, '1')}]
              when l < 8 then array[${idSql(0x0603, `2 + ${h(7, 50)}`)}]
              when l < 16 then array[${idSql(0x0603, `52 + ${h(8, 500)}`)}, ${idSql(0x0603, `52 + ${h(9, 500)}`)}]
              else array[${idSql(0x0603, `552 + ${h(10, 2000)}`)}, ${idSql(0x0603, `552 + ${h(11, 2000)}`)},
                         ${idSql(0x0603, `552 + ${h(12, 2000)}`)}] end,
         case when ${h(13, 2)} = 0 then null else 10000000 + ${h(14, 50)}::bigint * 1000000 end,
         case when ${h(15, 3)} = 0 then null else 60000000 + ${h(16, 60)}::bigint * 5000000 end
    from (select g, ${h(0, 20)} as l from generate_series(${from}, ${to}) g) s;
  set session_replication_role = default;`;

async function cleanUp(): Promise<void> {
  // replica: the agencies' guard and directory triggers stay out of it (so does the terms' cascade: deleted first)
  await adminQuery(`set statement_timeout = 0; set session_replication_role = replica;
    delete from network_subscription_terms where agency_id::text like '${space(0x0601)}%';
    delete from network_subscriptions where agency_id::text like '${space(0x0601)}%';
    delete from agencies where agency_id::text like '${space(0x0601)}%';
    set session_replication_role = default;`);
}

/** VACUUMs until the visibility map covers (nearly) every page (search-fallback's helper, S7-F11). */
async function vacuumUntilAllVisible(table: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await adminQuery(`vacuum analyze ${table}`);
    const [row] = await adminQuery<{ pages: number; visible: number }>(
      'select relpages as pages, relallvisible as visible from pg_class where oid = $1::regclass',
      [table],
    );
    if (row && row.visible >= row.pages * 0.99) return;
    if (attempt === 10) throw new Error(`${table}: ${row?.visible} of ${row?.pages} pages all-visible`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

const post = (over: Partial<PostRow>): PostRow => ({
  id: id(0x0604, 1),
  agencyId: id(0x0604, 2),
  kind: 'BUYER_REQUEST',
  status: 'OPEN',
  title: 'Perf',
  body: 'Perf',
  transactionType: null,
  propertyTypeIds: null,
  locationIds: null,
  locationScopeIds: null,
  featureIds: null,
  priceMinCents: null,
  priceMaxCents: null,
  currency: 'EUR',
  bedsMin: null,
  bathsMin: null,
  areaMinM2: null,
  areaMaxM2: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt: new Date(),
  ...over,
});

/** A buyer request for a villa in one area (its scope: the area, its city, region and the country), in budget. */
const narrow = post({
  transactionType: 'SALE',
  propertyTypeIds: [place(2601)],
  locationIds: [place(552)],
  locationScopeIds: [place(1), place(2), place(52), place(552)],
  priceMinCents: 30_000_000,
  priceMaxCents: 80_000_000,
});
/** A property offer without criteria (matches subscriptions that set none but kinds), and the same in a city. */
const broad = post({ kind: 'PROPERTY_OFFER' });
const broadInCity = post({ kind: 'PROPERTY_OFFER', locationScopeIds: [place(1), place(3), place(60)] });

class Rollback extends Error {}

/** EXPLAIN (ANALYZE, BUFFERS) of the walk's batch in a rolled-back system transaction: the fastest of five. */
async function explainBatch(p: PostRow, after: SubscriberRow | null): Promise<{ plan: string; ms: number }> {
  const once = () =>
    withSystem('perf.network-subscribers', async (tx: Tx) => {
      const plan = await withWalkPlan(tx, async () => {
        const res = await tx.execute(
          sql`explain (analyze, buffers) ${matchingSubscribersQuery(p, after, SUBSCRIBER_BATCH)}`,
        );
        return (res.rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0])).join('\n');
      });
      throw Object.assign(new Rollback(), { plan });
    }).catch((err: unknown) => {
      if (err instanceof Rollback) return (err as Rollback & { plan: string }).plan;
      throw err;
    });
  await once();
  const runs: { plan: string; ms: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const plan = await once();
    runs.push({ plan, ms: Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]) });
  }
  return runs.reduce((x, y) => (x.ms <= y.ms ? x : y));
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await cleanUp();
  const started = Date.now();
  await adminQuery(`set session_replication_role = replica;
    insert into agencies (agency_id, kind, status, name)
    select ${idSql(0x0601, 'n')}, 'AGENCY', 'VERIFIED', 'Perf subscribers ' || n from generate_series(1, ${AGENCIES}) n;
    set session_replication_role = default;`);
  for (let from = 1; from <= ROWS; from += BATCH) {
    await adminQuery(`set statement_timeout = 0; ${seed(from, Math.min(ROWS, from + BATCH - 1))}`);
  }
  // the terms in one statement, as the migration's backfill writes them
  await adminQuery(`set statement_timeout = 0;
    insert into network_subscription_terms (agency_id, subscription_id, user_id, location_id, kind, transaction_type,
                                            property_type_ids, price_min_cents, price_max_cents)
    select s.agency_id, s.id, s.user_id, l, k, coalesce(s.transaction_type, '*'), s.property_type_ids,
           s.price_min_cents, s.price_max_cents
      from network_subscriptions s
     cross join lateral unnest(coalesce(s.location_ids, array['00000000-0000-0000-0000-000000000000'::uuid])) l
     cross join lateral unnest(coalesce(s.kinds, array['*'])) k
     where s.agency_id::text like '${space(0x0601)}%'
    on conflict do nothing;`);
  await vacuumUntilAllVisible('network_subscriptions');
  await vacuumUntilAllVisible('network_subscription_terms');
  const [terms] = await adminQuery<{ n: number }>(
    `select count(*)::int as n from network_subscription_terms where agency_id::text like '${space(0x0601)}%'`,
  );
  log.info({ rows: ROWS, terms: terms?.n, seconds: Math.round((Date.now() - started) / 1000) }, 'subscriptions loaded');
}, 1_800_000);

afterAll(async () => {
  await cleanUp();
  await closeDb();
}, 600_000);

it('[S12-F3] a 1M-subscription seed gives the subscriber batch < 20 ms with index scans only (EXPLAIN)', async () => {
  const positions: (SubscriberRow | null)[] = [
    null,
    ...[0.2, 0.5, 0.8, 0.99].map((f) => ({
      agencyId: id(0x0601, Math.floor(AGENCIES * f)),
      userId: id(0x0602, 0),
    })),
  ];
  const report: Record<string, number[]> = {};
  for (const [name, p] of Object.entries({ narrow, broad, broadInCity })) {
    report[name] = [];
    for (const after of positions) {
      const best = await explainBatch(p, after);
      report[name].push(Math.round(best.ms * 10) / 10);
      if (after === null) log.info({ shape: name, ms: best.ms }, `subscriber batch plan:\n${best.plan}`);
      expect(best.plan, name).toMatch(/Index Only Scan using network_subscription_terms_walk_idx/);
      expect(best.plan, name).not.toMatch(/Seq Scan|Bitmap Heap Scan|HashAggregate|Hash Join|Gather/);
      expect(best.ms, `${name} after ${after?.agencyId ?? 'start'}`).toBeLessThan(SQL_BUDGET_MS);
    }
  }
  log.info(report, 'subscriber batch ms by shape and walk position');
});

it('[S12-F3] the walk finds exactly the members the S11-05 predicate matches', async () => {
  const walked = new Set<string>();
  let after: SubscriberRow | null = null;
  let batches = 0;
  const t0 = performance.now();
  for (;;) {
    const rows: SubscriberRow[] = await withSystem('perf.network-subscribers', (tx) =>
      matchingSubscribers(tx, narrow, after, SUBSCRIBER_BATCH),
    );
    batches += 1;
    for (const r of rows) walked.add(`${r.agencyId}:${r.userId}`);
    if (rows.length < SUBSCRIBER_BATCH) break;
    after = rows.at(-1) as SubscriberRow;
  }
  const walkMs = performance.now() - t0;
  const scope = `array[${(narrow.locationScopeIds ?? []).map((x) => `'${x}'::uuid`).join(', ')}]`;
  const expected = await adminQuery<{ agency_id: string; user_id: string }>(`
    select distinct agency_id, user_id from network_subscriptions
     where agency_id::text like '${space(0x0601)}%'
       and (kinds is null or 'BUYER_REQUEST' = any(kinds))
       and (transaction_type is null or transaction_type = 'SALE')
       and (property_type_ids is null or property_type_ids && array['${place(2601)}'::uuid])
       and (location_ids is null or location_ids && ${scope})
       and (price_max_cents is null or price_max_cents >= 30000000)
       and (price_min_cents is null or price_min_cents <= 80000000)`);
  const mine = [...walked].filter((k) => k.startsWith(space(0x0601)));
  log.info({ members: mine.length, batches, walkMs: Math.round(walkMs) }, 'subscriber walk');
  expect(mine.length).toBe(expected.length);
  expect(new Set(mine)).toEqual(new Set(expected.map((r) => `${r.agency_id}:${r.user_id}`)));
});
