import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import { finishedStats, finishedStatsSql, WAIT_HISTOGRAM_MAX_ROWS } from '../repo';

/** The staff health window's statement stays bounded when every run waited a different time (S7-F10 perf review). */

const RUNS = 20_000;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.health.test', fn);
let owner: Founder;
const connectionId = newId();

beforeAll(async () => {
  await setupTestDb('worker');
  owner = await createFounder();
  await system(async (tx) => {
    await tx.execute(sql`
      insert into feed_connections (id, agency_id, name, connector, url)
      values (${connectionId}, ${owner.agencyId}, 'Backlog feed', 'test-xml', 'https://feeds.example.com/backlog.xml')`);
    // A deep backlog: run g waited 7·g seconds (0 s … ~39 h, every wait distinct), finished just now.
    await tx.execute(sql`
      insert into feed_runs (id, agency_id, connection_id, trigger, state, created_at, started_at, finished_at)
      select gen_random_uuid(), ${owner.agencyId}, ${connectionId}, 'SCHEDULE', 'SUCCEEDED',
             now() - make_interval(secs => 60 + 7 * g), now() - interval '60 seconds', now()
        from generate_series(0, ${RUNS - 1}) as g`);
  });
}, 120_000);

afterAll(async () => {
  await system((tx) => tx.execute(sql`delete from feed_runs where connection_id = ${connectionId}`));
  await system((tx) => tx.execute(sql`delete from feed_connections where id = ${connectionId}`));
  await closeDb();
});

it('[S7-F10] the health window returns a bounded histogram with 20k distinct waits; max exact, p95 to its bucket', async () => {
  const since = new Date(Date.now() - 3_600_000);
  const rows = await system(async (tx) => (await tx.execute(finishedStatsSql(since))).rows);
  // Outcome groups (a handful) + wait buckets (≤ WAIT_HISTOGRAM_MAX_ROWS), not one row per distinct wait.
  expect(rows.length).toBeLessThanOrEqual(WAIT_HISTOGRAM_MAX_ROWS + 50);
  expect(rows.length).toBeLessThan(RUNS / 4);
  const stats = await system((tx) => finishedStats(tx, since));
  const longest = 7 * (RUNS - 1);
  expect(stats.max).toBeGreaterThanOrEqual(longest);
  expect(stats.max).toBeLessThanOrEqual(longest + 5);
  // Exact p95 of this backlog ≈ 7 · 0.95 · 19,999 s (~37 h): its bucket is an hour wide (the lower bound is reported).
  const exact = 7 * 0.95 * (RUNS - 1);
  expect(stats.p95).toBeLessThanOrEqual(exact + 60);
  expect(stats.p95).toBeGreaterThanOrEqual(exact - 3_600);
});
