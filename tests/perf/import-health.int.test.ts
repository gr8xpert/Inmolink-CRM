import { withStaffCtx } from '@inmolink/core';
import * as imports from '@inmolink/core/modules/imports';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { adminQuery, createStaffUser, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * Staff import health at scale (S7-F10, S6-08 endpoint): 300,000 runs of 1,000 connections over 30 days — 120,000 of
 * them in the 24-hour window (5,000 hourly feeds' day) — plus 1,000 queued runs and 50 paused connections. The endpoint
 * stays within the dashboard budget (≤ 10 queries, p95 < 300 ms) and every statement it runs is EXPLAINed as `app_staff`
 * (no Seq Scan on the run or connection tables). The plans are logged for STATUS.
 */

const log = createLogger({ service: 'perf', level: 'info' });
const AGENCIES = 10;
const CONNECTIONS_PER_AGENCY = 100;
const CONNECTIONS = AGENCIES * CONNECTIONS_PER_AGENCY;
const RUNS = 300_000;
const IN_WINDOW = 120_000;
const PAUSED = 50;
const P95_BUDGET_MS = 300;
const QUERY_BUDGET = 10;
const CODES = [
  'FEED_FETCH_FAILED',
  'FEED_HTTP_STATUS',
  'FEED_TIMEOUT',
  'FEED_MALFORMED',
  'FEED_PAUSED_MASS_WITHDRAWAL',
];

const founders: Founder[] = [];
let staffId = '';
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.import-health', fn);
const agencyIds = () =>
  sql.join(
    founders.map((f) => sql`${f.agencyId}::uuid`),
    sql`, `,
  );
const asStaff = <T>(fn: Parameters<typeof withStaffCtx<T>>[1]) =>
  withStaffCtx({ userId: staffId, requestId: newId(), reason: 'perf.import-health' }, fn);
const p95 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.ceil(xs.length * 0.95) - 1] as number;

beforeAll(async () => {
  await setupTestDb('worker');
  for (let i = 0; i < AGENCIES; i++) founders.push(await createFounder());
  staffId = (await createStaffUser('STAFF_SUPPORT')).userId;
  const codes = sql.raw(`array[${CODES.map((c) => `'${c}'`).join(', ')}]`);
  await system(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '10min'`);
    await tx.execute(sql`
      insert into feed_connections (id, agency_id, name, connector, url, schedule_minutes)
      select gen_random_uuid(), a.id, 'Health feed ' || n, 'test-xml', 'https://feeds.example.com/' || n || '.xml', 60
        from unnest(array[${agencyIds()}]) as a(id), generate_series(1, ${CONNECTIONS_PER_AGENCY}) as n`);
    // Run g: connection g % 1,000; the first 120k finished within the last 24 h, the rest over the 29 days before;
    // waited 0–10 min for a worker, ran 30 s–10 min; one in ten failed (five codes, one a pause).
    await tx.execute(sql`
      with c as (select id, agency_id, (row_number() over (order by id) - 1)::int as k from feed_connections
                  where agency_id in (${agencyIds()}))
      insert into feed_runs (id, agency_id, connection_id, trigger, state, error_code, created_at, started_at, finished_at)
      select gen_random_uuid(), c.agency_id, c.id, 'SCHEDULE',
             (case when g % 10 = 3 then 'FAILED' else 'SUCCEEDED' end)::feed_run_state,
             case when g % 10 = 3 then (${codes})[1 + (g / 10) % ${CODES.length}] end,
             f - make_interval(secs => 30 + g % 570 + g % 600), f - make_interval(secs => 30 + g % 570), f
        from generate_series(1, ${RUNS}) as g
        join c on c.k = g % ${CONNECTIONS}
        cross join lateral (select case when g <= ${IN_WINDOW}
                                        then now() - make_interval(secs => g * 86400.0 / ${IN_WINDOW})
                                        else now() - interval '1 day'
                                             - make_interval(secs => (g - ${IN_WINDOW}) * 86400.0 * 29 / ${RUNS - IN_WINDOW})
                                   end as f) t`);
    // One queued run per connection (the per-connection mutex allows one), waiting up to 15 min.
    await tx.execute(sql`
      insert into feed_runs (id, agency_id, connection_id, trigger, state, created_at)
      select gen_random_uuid(), agency_id, id, 'SCHEDULE', 'QUEUED',
             now() - make_interval(secs => (row_number() over (order by id))::int % 900)
        from feed_connections where agency_id in (${agencyIds()})`);
    await tx.execute(sql`
      update feed_connections set paused_at = now() - make_interval(secs => n), pause_reason = 'MASS_WITHDRAWAL',
                                  pause_details = '{"missing": 10, "live": 20}'::jsonb
        from (select id, row_number() over (order by id)::int as n from feed_connections
               where agency_id in (${agencyIds()}) order by id limit ${PAUSED}) p
       where feed_connections.id = p.id`);
  });
  // As autovacuum would have: statistics and the visibility map (index-only scans).
  await adminQuery('vacuum analyze feed_runs');
  await adminQuery('vacuum analyze feed_connections');
}, 30 * 60_000);

afterAll(async () => {
  await system(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '10min'`);
    await tx.execute(sql`delete from feed_runs where agency_id in (${agencyIds()})`);
    await tx.execute(sql`delete from feed_connections where agency_id in (${agencyIds()})`);
  });
  await closeDb();
}, 30 * 60_000);

it('[S7-F10] the staff import health endpoint: ≤ 10 queries, p95 < 300 ms and no Seq Scan on a 300k-run seed', async () => {
  for (let i = 0; i < 3; i++) await asStaff((ctx) => imports.getImportHealth(ctx)); // warm pool and cache
  const times: number[] = [];
  let health: Awaited<ReturnType<typeof imports.getImportHealth>> | undefined;
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    health = await asStaff((ctx) => imports.getImportHealth(ctx));
    times.push(performance.now() - started);
  }
  // Every run of the window is counted (other test files' runs may add some).
  expect(health?.runs.finished).toBeGreaterThanOrEqual(IN_WINDOW - 100);
  expect(health?.runs.failed).toBeGreaterThanOrEqual(IN_WINDOW / 10 - 100);
  expect(health?.lag.queued).toBeGreaterThanOrEqual(CONNECTIONS);
  expect(health?.paused.length).toBeGreaterThan(0);

  const statements: { query: string; params: unknown[] }[] = [];
  const queries = await countQueries(() => asStaff((ctx) => imports.getImportHealth(ctx)), {
    onQuery: (query, params) => statements.push({ query, params }),
  });
  // Each statement as staff ran it (role `app_staff`, the staff member's settings), EXPLAINed: plan, time, buffers.
  const plans: { statement: string; ms: number; scans: string[] }[] = [];
  // The endpoint's own statements (the staff session's checks run as another role and are not the endpoint's cost).
  for (const s of statements.filter((x) => /feed_runs|feed_connections|taxonomy_unmatched/.test(x.query))) {
    const text = await withAdminRollback([], async (q) => {
      // Planner costs are production's, set on the test database (`setupTestDb`, S7-F10 review).
      await q('set local role app_staff');
      await q(`select set_config('app.user_id', $1, true), set_config('app.staff_reason', 'perf', true)`, [staffId]);
      const rows = await q(`explain (analyze, buffers, costs off) ${s.query}`, s.params);
      return rows.map((r) => String(Object.values(r)[0])).join('\n');
    });
    plans.push({
      statement: s.query.replace(/\s+/g, ' ').trim().slice(0, 90),
      ms: Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1]),
      scans: text
        .split('\n')
        .filter((l) => /Scan|Aggregate|Sort/.test(l))
        .map((l) =>
          l
            .trim()
            .replace(/\(actual time=[^)]*\)/, '')
            .slice(0, 110),
        ),
    });
    expect(text, s.query).not.toMatch(/Seq Scan on (feed_runs|feed_connections)/);
  }
  log.info(
    { runs: RUNS, inWindow: IN_WINDOW, p95Ms: Math.round(p95(times)), queries, plans },
    '[S7-F10] staff import health at scale',
  );
  expect(queries).toBeLessThanOrEqual(QUERY_BUDGET);
  expect(p95(times)).toBeLessThan(P95_BUDGET_MS);
}, 600_000);
