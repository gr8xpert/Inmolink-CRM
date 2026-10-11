import { listen, withSystem, withTenant } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import {
  createDispatcher,
  defineEvent,
  emit,
  OUTBOX_CHANNEL,
  PLATFORM_AGENCY_ID,
  replayOutboxBatch,
  SubscriberRegistry,
} from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  log,
  pendingOf,
  pruneTestOutbox,
  runId,
  runSystem,
  setupQueueTest,
  teardownQueueTest,
  waitFor,
} from './helpers';

const run = runId();
const noted = defineEvent(`test.${run}.noted`, 1, z.object({ agencyId: z.uuid(), n: z.number().int() }));
const platformWide = defineEvent(`test.${run}.platform`, 1, z.object({ n: z.number().int() }));
const types = [noted.type, platformWide.type];

class Rollback extends Error {}

async function drain(dispatcher: ReturnType<typeof createDispatcher>): Promise<void> {
  // Rows of other suites (isolation fixtures) may be claimed too; loop until ours are done.
  await waitFor(async () => {
    await dispatcher.runOnce();
    return (await pendingOf(types)) === 0;
  });
}

describe('outbox', () => {
  beforeAll(async () => {
    await setupQueueTest(`test-${run}`);
    await pruneTestOutbox();
  });
  afterAll(() => teardownQueueTest([]));

  it('[S0-06] an event emitted in a rolled-back transaction is never dispatched', async () => {
    const agencyId = newId();
    const subscribers = new SubscriberRegistry();
    const seen: number[] = [];
    subscribers.add(noted, (p) => {
      seen.push(p.n);
    });
    const dispatcher = createDispatcher({ runSystem, logger: log, subscribers });

    await expect(
      withTenant({ agencyId }, async (tx) => {
        await emit(tx, noted({ agencyId, n: 1 }));
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    await withTenant({ agencyId }, (tx) => emit(tx, noted({ agencyId, n: 2 })));

    await drain(dispatcher);
    expect(seen).toEqual([2]);
    const { rows } = await withSystem('test', (tx) =>
      tx.execute(
        sql`select payload->>'n' as n from outbox_events where type = ${noted.type} and agency_id = ${agencyId}`,
      ),
    );
    expect(rows.map((r) => r.n)).toEqual(['2']);
  });

  it('[S0-06] a tenant cannot emit events for another agency (RLS)', async () => {
    const a = newId();
    const b = newId();
    await expect(withTenant({ agencyId: a }, (tx) => emit(tx, noted({ agencyId: b, n: 1 })))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(
      withTenant({ agencyId: a }, (tx) => emit(tx, platformWide({ n: 1 }), { agencyId: PLATFORM_AGENCY_ID })),
    ).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('[S0-06] emit refuses a payload agency that differs from the row agency, and oversized payloads', async () => {
    const a = newId();
    await expect(
      withSystem('test', (tx) => emit(tx, noted({ agencyId: newId(), n: 1 }), { agencyId: a })),
    ).rejects.toThrow(/differ/);
    const huge = defineEvent(`test.${run}.huge`, 1, z.object({ blob: z.string() }));
    await expect(withSystem('test', (tx) => emit(tx, huge({ blob: 'x'.repeat(20_000) })))).rejects.toThrow(/max 10240/);
  });

  it('[S0-06] events without agencyId take the tenant from the transaction, or the platform id under withSystem', async () => {
    const agencyId = newId();
    await withTenant({ agencyId }, (tx) => emit(tx, platformWide({ n: 10 })));
    await withSystem('test', (tx) => emit(tx, platformWide({ n: 11 })));
    const { rows } = await withSystem('test', (tx) =>
      tx.execute(
        sql`select agency_id, payload->>'n' as n from outbox_events where type = ${platformWide.type} order by id`,
      ),
    );
    expect(rows).toEqual([
      { agency_id: agencyId, n: '10' },
      { agency_id: PLATFORM_AGENCY_ID, n: '11' },
    ]);
    await drain(createDispatcher({ runSystem, logger: log, subscribers: new SubscriberRegistry() }));
  });

  it('[S0-06] failing subscribers retry with backoff, dead-letter after maxAttempts and replay', async () => {
    const agencyId = newId();
    const subscribers = new SubscriberRegistry();
    let fail = true;
    const seen: number[] = [];
    subscribers.add(noted, (p) => {
      if (fail) throw new Error('downstream unavailable');
      seen.push(p.n);
    });
    const dispatcher = createDispatcher({ runSystem, logger: log, subscribers, maxAttempts: 2, backoffMs: () => 0 });
    await withSystem('test', (tx) => emit(tx, noted({ agencyId, n: 7 })));

    await drain(dispatcher);
    const { rows } = await withSystem('test', (tx) =>
      tx.execute(sql`select attempts, dead_at is not null as dead, last_error from outbox_events
                      where type = ${noted.type} and agency_id = ${agencyId}`),
    );
    expect(rows[0]).toMatchObject({ attempts: 2, dead: true });
    expect(String(rows[0]?.last_error)).toContain('downstream unavailable');

    fail = false;
    expect(await withSystem('test', (tx) => replayOutboxBatch(tx, { type: noted.type, deadOnly: true }))).toMatchObject(
      {
        replayed: 1,
      },
    );
    await drain(dispatcher);
    expect(seen).toEqual([7]);
  });

  it('[S0-06] an event type this process does not define is retried and dead-lettered, never marked processed', async () => {
    // A row from a newer deploy (or a module the worker does not load): no defineEvent here.
    const unknown = { type: `test.${run}.unknown`, version: 1, payload: { n: 1 } };
    await withSystem('test', (tx) => emit(tx, unknown));
    const dispatcher = createDispatcher({
      runSystem,
      logger: log,
      subscribers: new SubscriberRegistry(),
      maxAttempts: 2,
      backoffMs: () => 0,
    });

    await waitFor(async () => {
      await dispatcher.runOnce();
      return (await pendingOf([unknown.type])) === 0;
    });
    const { rows } = await withSystem('test', (tx) =>
      tx.execute(sql`select attempts, dead_at is not null as dead, last_error from outbox_events
                       where type = ${unknown.type}`),
    );
    expect(rows[0]).toMatchObject({ attempts: 2, dead: true });
    expect(String(rows[0]?.last_error)).toContain('is not defined in this process');
  });

  it('[S0-06] NOTIFY wakes an idle dispatcher immediately (polling is only a fallback)', async () => {
    const agencyId = newId();
    const subscribers = new SubscriberRegistry();
    const seen: number[] = [];
    subscribers.add(noted, (p) => {
      seen.push(p.n);
    });
    const dispatcher = createDispatcher({
      runSystem,
      logger: log,
      subscribers,
      pollMs: 60_000,
      listen: (cb) => listen(OUTBOX_CHANNEL, cb),
    });
    await dispatcher.start();
    try {
      await waitFor(async () => (await pendingOf(types)) === 0, 10_000); // initial catch-up round
      const t0 = Date.now();
      await withTenant({ agencyId }, (tx) => emit(tx, noted({ agencyId, n: 42 })));
      await waitFor(() => seen.includes(42), 5_000, 10);
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      await dispatcher.stop();
    }
  });
});
