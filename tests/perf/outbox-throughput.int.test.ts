import { withSystem } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { createDispatcher, defineEvent, emit, SubscriberRegistry } from '@inmolink/platform/outbox';
import { defineJob, queueFor } from '@inmolink/platform/queue';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  log,
  pendingOf,
  pruneTestOutbox,
  restartRedisQueue,
  runId,
  runSystem,
  setupQueueTest,
  teardownQueueTest,
  waitFor,
} from '../queue/helpers';

const run = runId();
const POOL = 'test-fanout';
const WINDOW = 10_000;
const WINDOWS = 3;
const TOTAL = WINDOW * WINDOWS;
const RESTART_BACKLOG = 20_000;
const changed = defineEvent(
  `test.${run}.changed`,
  1,
  z.object({ agencyId: z.uuid(), entityId: z.uuid(), seq: z.number().int() }),
);

// Subscriber fan-out as in PATTERNS §8: one job per event, stable ID so redelivery is a no-op.
const fanout = defineJob({
  name: 'test.fanout',
  pool: POOL,
  payload: z.object({ agencyId: z.uuid(), entityId: z.uuid(), seq: z.number().int() }),
  jobId: (p) => `${p.entityId}`,
  group: (p) => p.agencyId, // tenant fair share is part of the measured path
  async run() {},
});

// S12-F19 scope: the dispatcher claims only these agencies' events. The shared test database keeps other suites'
// pending rows (types this process does not declare, so retried, never done): unscoped, they took fair-share slots of
// every claim and the measured rate fell to ~900 events/s on CI.
const THROUGHPUT_AGENCY = newId();
const RESTART_AGENCY = newId();

async function emitBulk(agencyId: string, count: number, offset: number): Promise<void> {
  for (let i = 0; i < count; i += 1_000) {
    const batch = Array.from({ length: Math.min(1_000, count - i) }, (_, j) =>
      changed({ agencyId, entityId: newId(), seq: offset + i + j }),
    );
    await withSystem('test.emit', (tx) => emit(tx, batch));
  }
}

async function queued(): Promise<number> {
  const counts = await queueFor(POOL).getJobCounts('wait', 'prioritized', 'delayed', 'active', 'completed', 'failed');
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

describe('outbox dispatcher throughput', () => {
  const subscribers = new SubscriberRegistry();
  subscribers.add(changed, (p, meta) => fanout.enqueue({ agencyId: meta.agencyId, entityId: p.entityId, seq: p.seq }));

  beforeAll(async () => {
    await setupQueueTest(`test-${run}`);
    await pruneTestOutbox();
  });
  afterAll(() => teardownQueueTest([POOL]));

  it('[S0-06] [S1-F2] dispatcher sustains ≥ 2,000 events/s locally with zero loss across a Redis restart (AOF)', async () => {
    // 1) Throughput: a 30,000-event backlog through claim → enqueue (grouped, batched) → ack, timed per
    //    10,000-event window. On a shared dev machine one window can catch autovacuum, an AOF rewrite or
    //    desktop load, so the check is the best sustained window; all three and the overall rate are reported.
    await emitBulk(THROUGHPUT_AGENCY, TOTAL, 0);
    const dispatcher = createDispatcher({
      runSystem,
      logger: log,
      subscribers,
      pollMs: 50,
      agencyIds: [THROUGHPUT_AGENCY, RESTART_AGENCY],
    });
    const t0 = performance.now();
    const marks: number[] = [];
    await dispatcher.start();
    await waitFor(
      async () => {
        const left = await pendingOf([changed.type]);
        while (marks.length < WINDOWS && left <= TOTAL - (marks.length + 1) * WINDOW) marks.push(performance.now());
        return left === 0;
      },
      120_000,
      50,
    );
    const windows = marks.map((t, i) => WINDOW / ((t - (i === 0 ? t0 : (marks[i - 1] as number))) / 1_000));
    const overall = TOTAL / (((marks.at(-1) as number) - t0) / 1_000);
    const best = Math.max(...windows);
    log.info({ windows, overall }, 'outbox throughput');
    console.info(
      `[S0-06] outbox dispatch: windows ${windows.map((r) => Math.round(r)).join(' / ')} events/s, overall ${Math.round(overall)} events/s`,
    );
    // CI runners (Linux, nothing else on the box) are held to the overall rate (STATUS › Decisions, S0-06).
    expect(process.env.CI === 'true' ? overall : best).toBeGreaterThanOrEqual(2_000);
    expect(await queued()).toBe(TOTAL);

    // 2) Zero loss: a 20,000-event backlog (several seconds of work) dispatched while redis-queue restarts.
    await dispatcher.stop();
    await emitBulk(RESTART_AGENCY, RESTART_BACKLOG, TOTAL);
    await dispatcher.start();
    await restartRedisQueue();
    // The restart finished while dispatch was still running, so it hit enqueues in flight.
    expect(await pendingOf([changed.type])).toBeGreaterThan(0);
    await waitFor(async () => (await pendingOf([changed.type])) === 0, 120_000, 200);
    await dispatcher.stop();

    // Every event became exactly one job; the restart lost none (AOF) and redelivery duplicated none.
    expect(await queued()).toBe(TOTAL + RESTART_BACKLOG);
    const { rows } = await withSystem('test', (tx) =>
      tx.execute(
        sql`select count(*)::int as dead from outbox_events where type = ${changed.type} and dead_at is not null`,
      ),
    );
    expect(rows[0]?.dead).toBe(0);
  });
});
