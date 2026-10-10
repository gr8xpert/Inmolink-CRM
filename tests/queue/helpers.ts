import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { closeDb, type Tx, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createLogger } from '@inmolink/platform/logger';
import type { SqlExecutor } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue, queueFor } from '@inmolink/platform/queue';
import { sql } from 'drizzle-orm';

const ROOT = join(import.meta.dirname, '..', '..');

export const log = createLogger({ service: 'queue-test', level: 'silent' });

/** Unique per file run: event types and the Redis key prefix, so runs and parallel suites never collide. */
export const runId = () => `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** DB as a worker (withSystem allowed) + queues under their own Redis prefix. */
export async function setupQueueTest(prefix: string): Promise<void> {
  await setupTestDb('worker');
  await configureQueue({ prefix, logger: log });
}

export async function teardownQueueTest(pools: string[]): Promise<void> {
  for (const pool of pools) {
    for (const name of [pool, `${pool}.dead`]) await queueFor(name).obliterate({ force: true });
  }
  await closeQueues();
  await closeDb();
}

/** `withSystem` typed for platform's structural executor. */
export const runSystem = <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> =>
  withSystem(reason, (tx: Tx) => fn(tx));

/** Outbox rows of the given types that are not yet processed. */
export async function pendingOf(types: string[]): Promise<number> {
  const { rows } = await withSystem('test.pending', (tx) =>
    tx.execute(sql`select count(*)::int as n from outbox_events
                    where processed_at is null and type in (select jsonb_array_elements_text(${JSON.stringify(types)}::jsonb))`),
  );
  return Number(rows[0]?.n);
}

/**
 * Deletes outbox rows left by earlier local runs (types `test.*`, older than 10 minutes), so the shared
 * test table does not grow without bound and skew timings. Rows of suites running right now are kept.
 */
export async function pruneTestOutbox(): Promise<void> {
  await withSystem('test.prune', (tx) =>
    tx.execute(sql`delete from outbox_events where type like 'test.%' and created_at < now() - interval '10 minutes'`),
  );
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 30_000, stepMs = 50): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Restarts the test redis-queue container (graceful: AOF is flushed on shutdown). `docker compose restart`
 * drops the published port on Docker Desktop for Windows, and plain `docker restart` sometimes does too;
 * a container that came back without its port is recreated (same volume, so the AOF survives) —
 * otherwise this run and every later one would fail to reach Redis.
 */
export async function restartRedisQueue(): Promise<void> {
  const id = execFileSync('docker', ['compose', '--profile', 'test', 'ps', '-q', 'redis-queue-test'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (!id) throw new Error('redis-queue-test is not running');
  // Async, so the dispatcher in this process keeps delivering while Redis goes down and comes back.
  const run = promisify(execFile);
  await run('docker', ['restart', id], { timeout: 60_000 });
  const port = await run('docker', ['port', id, '6379/tcp'], { timeout: 10_000 }).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  if (port === '') {
    await run(
      'docker',
      ['compose', '--profile', 'test', 'up', '-d', '--wait', '--force-recreate', '--no-deps', 'redis-queue-test'],
      { cwd: ROOT, timeout: 120_000 },
    );
  }
}
