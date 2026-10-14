import { withSystem, withTenant } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import {
  createDispatcher,
  defineEvent,
  emit,
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

/** Agencies with due rows of other suites' types: each takes a slot in the claim's agency rotation. */
async function foreignDueAgencies(): Promise<number> {
  const { rows } = await withSystem('test.foreign', (tx) =>
    tx.execute(sql`select count(distinct agency_id)::int as n from outbox_events
                    where processed_at is null and available_at <= now()
                      and type not in (select jsonb_array_elements_text(${JSON.stringify(types)}::jsonb))`),
  );
  return Number(rows[0]?.n);
}

/** Due rows of other suites' types (never dispatched by anyone): they take their share of a batch too. */
async function foreignDue(): Promise<number> {
  const { rows } = await withSystem('test.foreign', (tx) =>
    tx.execute(sql`select count(*)::int as n from outbox_events
                    where processed_at is null and available_at <= now()
                      and type not in (select jsonb_array_elements_text(${JSON.stringify(types)}::jsonb))`),
  );
  return Number(rows[0]?.n);
}

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

  it('[S1-F2] [S2-F3] an idle dispatcher picks up a new event within one 250 ms poll interval (ADR 0014)', async () => {
    // Measured on the dispatcher's own clock (S2-F3): wall-clock latency failed under a full parallel verify
    // (577 ms, later 2.5 s) while the dispatcher did exactly what it should. What is checked: idle lanes
    // sleep the 250 ms poll interval between claims, and the lane that claimed the event did so in its first
    // round after the commit (or one already under way) — it never slept past a due row. Other lanes may
    // start a moment earlier and skip the row the claiming lane holds (`skip locked`): that is correct.
    const POLL_MS = 250;
    const agencyId = newId();
    const subscribers = new SubscriberRegistry();
    const seen = new Set<number>();
    subscribers.add(noted, (p) => {
      seen.add(p.n);
    });
    // `endedAt`: when the claim returned (the observer runs right after it; an empty round ends there).
    const rounds: { lane: number; startedAt: number; endedAt: number; ids: readonly string[] }[] = [];
    const dispatcher = createDispatcher({
      runSystem,
      logger: log,
      subscribers,
      pollMs: POLL_MS,
      // Other suites' due agencies must not push ours out of the first claim (default cap 64 per claim).
      maxAgenciesPerClaim: 5_000,
      onClaim: (r) => rounds.push({ ...r, endedAt: performance.now() }),
    });
    await dispatcher.start();
    try {
      await waitFor(async () => (await pendingOf(types)) === 0, 10_000); // initial catch-up round
      await new Promise((r) => setTimeout(r, 3 * POLL_MS)); // every lane is now idle, sleeping its poll interval
      await withTenant({ agencyId }, (tx) => emit(tx, noted({ agencyId, n: 42 })));
      const committedAt = performance.now();
      await waitFor(() => seen.has(42), 10_000, 5);
      const [row] = (
        await runSystem('test.outbox.find', (tx) =>
          tx.execute(sql`select id from outbox_events where agency_id = ${agencyId} and type = ${noted.type}`),
        )
      ).rows as { id: string }[];
      const claimedBy = rounds.find((r) => r.ids.includes(row?.id as string));
      expect(claimedBy, 'the round that claimed the event').toBeDefined();
      const lane = (claimedBy as (typeof rounds)[number]).lane;
      const firstAfterCommit = rounds.find((r) => r.lane === lane && r.startedAt >= committedAt);
      if (firstAfterCommit) {
        expect((claimedBy as (typeof rounds)[number]).startedAt).toBeLessThanOrEqual(firstAfterCommit.startedAt);
      }
      // After an empty claim a lane sleeps one poll interval: never less (no busy loop), and at least once close
      // to it (the lanes poll on the 250 ms cadence, not slower). Measured from the empty claim's end, so a
      // claim slowed by other suites' rows does not count as sleep.
      const gaps: number[] = [];
      for (const lane of new Set(rounds.map((r) => r.lane))) {
        const own = rounds.filter((r) => r.lane === lane);
        for (let i = 1; i < own.length; i++) {
          if ((own[i - 1] as (typeof rounds)[number]).ids.length === 0) {
            gaps.push((own[i] as (typeof rounds)[number]).startedAt - (own[i - 1] as (typeof rounds)[number]).endedAt);
          }
        }
      }
      expect(gaps.length).toBeGreaterThan(0);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(POLL_MS - 5);
      expect(Math.min(...gaps)).toBeLessThan(2 * POLL_MS);
    } finally {
      await dispatcher.stop();
    }
  });

  it('[S1-F2] one agency emitting 50,000 events delays another agency by at most one batch', async () => {
    const burst = newId();
    const others = Array.from({ length: 9 }, () => newId());
    const subscribers = new SubscriberRegistry();
    const seen = new Map<string, number>();
    subscribers.add(noted, (p) => {
      seen.set(p.agencyId, (seen.get(p.agencyId) ?? 0) + 1);
    });
    await waitFor(async () => (await pendingOf(types)) === 0); // nothing of ours left from earlier tests
    // Earlier suites leave due rows of many agencies in the shared table; a large agency cap keeps our ten
    // in the first rotation (the cap itself is covered by the next test).
    const dispatcher = createDispatcher({
      runSystem,
      logger: log,
      subscribers,
      batchSize: 500,
      maxAgenciesPerClaim: 5_000,
    });

    try {
      for (let i = 0; i < 50_000; i += 1_000) {
        const batch = Array.from({ length: 1_000 }, (_, j) => noted({ agencyId: burst, n: i + j }));
        await withSystem('test.burst', (tx) => emit(tx, batch));
      }
      // Emitted after the burst, so a FIFO claim would deliver them only after 100 full batches.
      for (const agencyId of others) await withTenant({ agencyId }, (tx) => emit(tx, noted({ agencyId, n: 1 })));

      // Other suites leave due rows of their own types in the shared database; fair share hands those
      // small agencies their rows first, so the burst agency gets the batch minus everyone else's.
      // Rows of other suites that another transaction locks or deletes while the claim runs (suites share this
      // database in a full verify) are skipped, and their quota is not handed to anyone else: a claim falls
      // short by at most that many rows (S1-F10: it claimed 442 of 500 next to a parallel suite).
      let foreign = await foreignDue();
      const first = await dispatcher.runOnce();
      foreign = Math.max(foreign, await foreignDue());
      expect(first.claimed).toBeGreaterThanOrEqual(500 - foreign);
      expect(first.claimed).toBeLessThanOrEqual(500);
      for (const agencyId of others) expect(seen.get(agencyId)).toBe(1);
      expect(seen.get(burst)).toBeGreaterThanOrEqual(first.claimed - others.length - foreign);

      // With the others drained, the burst agency gets whole batches again.
      const before = seen.get(burst) as number;
      foreign = await foreignDue();
      const second = await dispatcher.runOnce();
      foreign = Math.max(foreign, await foreignDue());
      expect(second.claimed).toBeGreaterThanOrEqual(500 - foreign);
      expect(second.claimed).toBeLessThanOrEqual(500);
      expect((seen.get(burst) as number) - before).toBeGreaterThanOrEqual(second.claimed - foreign);
    } finally {
      await withSystem('test.cleanup', (tx) => tx.execute(sql`delete from outbox_events where type = ${noted.type}`));
    }
  });

  it('[S1-F2] more agencies than one claim serves: each claim takes the next agencies in rotation, none twice before all once', async () => {
    const agencies = Array.from({ length: 150 }, () => newId()).sort();
    const subscribers = new SubscriberRegistry();
    const servedBy = new Map<string, number[]>();
    let claimNo = 0;
    subscribers.add(noted, (p) => {
      servedBy.set(p.agencyId, [...(servedBy.get(p.agencyId) ?? []), claimNo]);
    });
    await waitFor(async () => (await pendingOf(types)) === 0);
    // 64 agencies per claim (3 rows each fit the equal share), so 150 agencies take three claims.
    const dispatcher = createDispatcher({
      runSystem,
      logger: log,
      subscribers,
      batchSize: 500,
      maxAgenciesPerClaim: 64,
    });
    try {
      for (let n = 0; n < 3; n++) {
        for (let i = 0; i < agencies.length; i += 75) {
          const batch = agencies.slice(i, i + 75).map((agencyId) => noted({ agencyId, n }));
          await withSystem('test.many', (tx) => emit(tx, batch));
        }
      }
      // Other suites' agencies take rotation slots too (one claim serves 64 agencies), so the ideal three
      // claims grow with them; one more for rows that come due or get leased meanwhile.
      const maxClaims = Math.ceil((agencies.length + (await foreignDueAgencies())) / 64) + 1;
      const claims: number[] = [];
      while (servedBy.size < agencies.length) {
        claimNo++;
        claims.push((await dispatcher.runOnce()).claimed);
        if (claimNo > maxClaims + 5) {
          throw new Error(`rotation did not reach every agency: ${servedBy.size} / ${agencies.length}`);
        }
      }
      expect(claimNo).toBeLessThanOrEqual(maxClaims);
      expect(claims.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(agencies.length * 3);
      // Every agency was served by exactly one claim, which took all three of its rows at once.
      for (const agencyId of agencies) {
        const by = servedBy.get(agencyId) ?? [];
        expect(by, agencyId).toHaveLength(3);
        expect(new Set(by).size, agencyId).toBe(1);
      }
      // Rotation: the agencies of claim k all sort after the agencies of claim k-1 (the cursor moved on).
      const firstOf = (k: number) => agencies.filter((a) => servedBy.get(a)?.[0] === k);
      for (let k = 2; k <= claimNo; k++) {
        const prev = firstOf(k - 1);
        const cur = firstOf(k);
        if (prev.length && cur.length) expect((cur[0] as string) > (prev.at(-1) as string), `claim ${k}`).toBe(true);
      }
    } finally {
      await withSystem('test.cleanup', (tx) => tx.execute(sql`delete from outbox_events where type = ${noted.type}`));
    }
  });
});
