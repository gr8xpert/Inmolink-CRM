import * as imports from '@inmolink/core/modules/imports';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Import throughput at scale (S7-F3): the scheduler queues every due connection in one job, batch after batch, and the
 * daily prune deletes every expired run in one job, a transaction per batch. In the `perf` project: the 200k-run seed
 * starves parallel suites of the test database (statement timeouts next to the core int forks).
 */

const log = createLogger({ service: 'imports-test', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.throughput.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const jobCtx = () => ({
  log,
  jobId: newId(),
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

const AGENCIES = 10;
const DUE_PER_AGENCY = 100;
const EXPIRED_RUNS = 200_000;
const founders: Founder[] = [];
const agencyIds = () =>
  sql.join(
    founders.map((f) => sql`${f.agencyId}::uuid`),
    sql`, `,
  );

beforeAll(async () => {
  await setupTestDb('worker');
  for (let i = 0; i < AGENCIES; i++) founders.push(await createFounder());
}, 120_000);

afterAll(async () => {
  await system(async (tx) => {
    await tx.execute(sql`delete from feed_runs where agency_id in (${agencyIds()})`);
    await tx.execute(sql`delete from feed_connections where agency_id in (${agencyIds()})`);
    await tx.execute(sql`delete from outbox_events where agency_id in (${agencyIds()})`);
  });
  await closeDb();
}, 300_000);

describe('import throughput', () => {
  it('[S7-F3] 1,000 due connections are all queued within one scheduler job', async () => {
    // 10 agencies × 100 due connections: a batch takes at most 10 of each agency, so this needs 5+ batches.
    await system((tx) =>
      tx.execute(sql`
        insert into feed_connections (id, agency_id, name, connector, url, schedule_minutes, next_run_at)
        select gen_random_uuid(), a.id, 'Due feed ' || n, 'test-xml', 'https://feeds.example.com/' || n || '.xml', 60,
               now() - make_interval(secs => n)
          from unnest(array[${agencyIds()}]) as a(id), generate_series(1, ${DUE_PER_AGENCY}) as n`),
    );
    expect(AGENCIES * DUE_PER_AGENCY).toBeGreaterThan(imports.RUNS.SCHEDULE_BATCH * 2);

    const result = (await imports.importsJobs.scheduleFeeds.spec.run({}, jobCtx())) as { queued: number };

    const [state] = await rows<{ queued: string; due: string; events: string }>(sql`
      select
        (select count(*) from feed_runs r join feed_connections c on c.id = r.connection_id
          where c.agency_id in (${agencyIds()}) and r.state = 'QUEUED' and r.trigger = 'SCHEDULE')::text as queued,
        (select count(*) from feed_connections where agency_id in (${agencyIds()}) and next_run_at <= now())::text as due,
        (select count(*) from outbox_events where agency_id in (${agencyIds()}) and type = 'imports.run.requested')::text
          as events`);
    expect(state).toEqual({
      queued: String(AGENCIES * DUE_PER_AGENCY),
      due: '0',
      events: String(AGENCIES * DUE_PER_AGENCY),
    });
    // a parallel test file's scheduler tick may have taken some of them; this job took the rest
    expect(result.queued).toBeGreaterThan(0);

    // Their slots moved on: the next tick finds nothing of theirs due and queues no second run.
    await imports.importsJobs.scheduleFeeds.spec.run({}, jobCtx());
    const [again] = await rows<{ n: string }>(sql`
      select count(*)::text as n from feed_runs where agency_id in (${agencyIds()})`);
    expect(again?.n).toBe(String(AGENCIES * DUE_PER_AGENCY));

    // A due connection without a schedule (a stray `next_run_at`) runs once and leaves the due set for good, so the
    // loop can never claim it again.
    const [owner] = founders as [Founder];
    const manual = newId();
    await system((tx) =>
      tx.execute(sql`
        insert into feed_connections (id, agency_id, name, connector, url, next_run_at)
        values (${manual}, ${owner.agencyId}, 'Manual feed', 'test-xml', 'https://feeds.example.com/manual.xml',
                now() - interval '1 minute')`),
    );
    await imports.importsJobs.scheduleFeeds.spec.run({}, jobCtx());
    const [m] = await rows<{ runs: string; next: string | null }>(sql`
      select (select count(*) from feed_runs where connection_id = ${manual})::text as runs,
             (select next_run_at::text from feed_connections where id = ${manual}) as next`);
    expect(m).toEqual({ runs: '1', next: null });
  }, 300_000);

  it('[S7-F3] a prune with 200k expired runs removes them all in one job', async () => {
    const [owner] = founders as [Founder];
    const connectionId = newId();
    await system(async (tx) => {
      await tx.execute(sql`
        insert into feed_connections (id, agency_id, name, connector, url)
        values (${connectionId}, ${owner.agencyId}, 'Prune feed', 'test-xml', 'https://feeds.example.com/prune.xml')`);
      // 100 days old (retention 90), half failed; one recent run stays.
      await tx.execute(sql`
        insert into feed_runs (id, agency_id, connection_id, trigger, state, created_at, started_at, finished_at)
        select gen_random_uuid(), ${owner.agencyId}, ${connectionId}, 'SCHEDULE',
               (case when n % 2 = 0 then 'SUCCEEDED' else 'FAILED' end)::feed_run_state,
               now() - interval '100 days' + make_interval(secs => n), now() - interval '100 days',
               now() - interval '100 days'
          from generate_series(1, ${EXPIRED_RUNS}) as n`);
      await tx.execute(sql`
        insert into feed_runs (id, agency_id, connection_id, trigger, state, finished_at)
        values (${newId()}, ${owner.agencyId}, ${connectionId}, 'MANUAL', 'SUCCEEDED', now())`);
      // item errors go with their runs: 1,000 each on 30 runs, 2 each on 2,000 others (`errors_logged` as kept)
      await tx.execute(sql`
        with heavy as (
          update feed_runs set errors_logged = case when n <= 30 then 1000 else 2 end,
                               items_failed = case when n <= 30 then 1000 else 2 end,
                               items_total = case when n <= 30 then 1000 else 2 end
            from (select id, row_number() over (order by created_at) as n from feed_runs
                   where connection_id = ${connectionId} and created_at < now() - interval '90 days'
                   order by created_at limit 2030) pick
           where feed_runs.id = pick.id
          returning feed_runs.id, feed_runs.agency_id, feed_runs.errors_logged
        )
        insert into feed_item_errors (id, agency_id, run_id, position, code)
        select gen_random_uuid(), h.agency_id, h.id, p, 'MISSING_FIELD'
          from heavy h, generate_series(1, h.errors_logged) as p`);
    });

    const started = performance.now();
    const result = (await imports.importsJobs.pruneRuns.spec.run({}, jobCtx())) as {
      deleted: number;
      errors: number;
      maxErrorsInBatch: number;
      more: boolean;
    };
    console.info(
      `[S7-F3] pruned ${result.deleted} runs, ${result.errors} errors in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );

    expect(result.more).toBe(false);
    expect(result.deleted).toBeGreaterThanOrEqual(EXPIRED_RUNS);
    // 34,000 errors went with them, no transaction deleting more than the bound
    expect(result.errors).toBeGreaterThanOrEqual(34_000);
    expect(result.maxErrorsInBatch).toBeLessThanOrEqual(imports.RUNS.PRUNE_ERRORS_PER_BATCH);
    const [left] = await rows<{ expired: string; mine: string; errors: string }>(sql`
      select
        (select count(*) from feed_runs
          where state in ('SUCCEEDED', 'FAILED') and created_at < now() - make_interval(days => ${imports.RUNS.RETENTION_DAYS}))::text
          as expired,
        (select count(*) from feed_runs where connection_id = ${connectionId})::text as mine,
        (select count(*) from feed_item_errors where agency_id = ${owner.agencyId})::text as errors`);
    expect(left).toEqual({ expired: '0', mine: '1', errors: '0' });
  }, 900_000);
  it('[S7-F3] seen references are UNLOGGED, vacuumed by row count and carry no unused agency index', async () => {
    const [table] = await rows<{ persistence: string; options: string[] }>(sql`
      select relpersistence as persistence, reloptions as options from pg_class where relname = 'property_import_seen'`);
    expect(table?.persistence).toBe('u');
    expect(table?.options).toEqual(
      expect.arrayContaining(['autovacuum_vacuum_scale_factor=0', 'autovacuum_vacuum_insert_scale_factor=0']),
    );
    const indexes = await rows<{ name: string }>(sql`
      select indexname as name from pg_indexes where tablename in ('property_import_seen', 'feed_image_queue')
       order by indexname`);
    expect(indexes.map((i) => i.name)).toEqual([
      'feed_image_queue_agency_created_idx',
      'feed_image_queue_pkey',
      'property_import_seen_created_idx',
      'property_import_seen_run_id_external_ref_pk',
    ]);
  });
});
