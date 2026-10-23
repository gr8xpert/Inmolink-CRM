import { defineJob, type PoolHandle, registerPool } from '@inmolink/platform/queue';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runId, setupQueueTest, teardownQueueTest, waitFor } from './helpers';

const run = runId();
const POOL = 'test-fair';
const CAP_POOL = 'test-fair-cap';
const JOB_MS = 200;
const PICKUP_MS = 50;
const handles: PoolHandle[] = [];

const startedAt = new Map<string, number>();
let started = 0;
// Observed, not nominal: timers overrun (≈16 ms granularity on Windows), and that is part of a job's duration.
let longestJob = 0;

const work = defineJob({
  name: 'test.fairWork',
  pool: POOL,
  payload: z.object({ group: z.string(), key: z.string() }),
  group: (p) => p.group,
  async run(p) {
    started++;
    const t0 = Date.now();
    startedAt.set(p.key, t0);
    await new Promise((r) => setTimeout(r, JOB_MS));
    longestJob = Math.max(longestJob, Date.now() - t0);
  },
});

const active = new Map<string, number>();
const maxActive = new Map<string, number>();
let capDone = 0;

const capped = defineJob({
  name: 'test.fairCapped',
  pool: CAP_POOL,
  payload: z.object({ group: z.string(), i: z.number() }),
  group: (p) => p.group,
  concurrencyPerGroup: 1,
  async run(p) {
    const n = (active.get(p.group) ?? 0) + 1;
    active.set(p.group, n);
    maxActive.set(p.group, Math.max(maxActive.get(p.group) ?? 0, n));
    await new Promise((r) => setTimeout(r, 30));
    active.set(p.group, n - 1);
    capDone++;
  },
});

describe('queue fair share', () => {
  beforeAll(() => setupQueueTest(`test-${run}`));
  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close()));
    await teardownQueueTest([POOL, CAP_POOL]);
  });

  it("[S0-06] with 10 groups, one group flooding 1,000 jobs does not delay another group's job by more than one job duration", async () => {
    const floods = Array.from({ length: 1_000 }, (_, i) => work.enqueue({ group: 'g0', key: `flood-${i}` }));
    await Promise.all(floods);
    handles.push(registerPool(POOL, [work], { concurrency: 10 }));
    await waitFor(() => started >= 20); // the flood is running and every slot is busy

    const enqueuedAt = new Map<string, number>();
    for (let g = 1; g <= 9; g++) {
      const key = `other-${g}`;
      await work.enqueue({ group: `g${g}`, key });
      enqueuedAt.set(key, Date.now()); // queued from here on; the enqueue round trip is not queueing delay
    }
    await waitFor(() => [...enqueuedAt.keys()].every((k) => startedAt.has(k)), 10_000, 5);

    const waits = [...enqueuedAt].map(([k, t]) => (startedAt.get(k) as number) - t);
    // A freed slot still needs one fetch round trip (fairness Lua + moveToActive) before the next job
    // starts; under parallel CI load that alone overran an exact bound by 1 ms. Waiting behind the flood
    // would cost whole job durations, which `started < 200` below also rules out.
    expect(Math.max(...waits)).toBeLessThanOrEqual(longestJob + PICKUP_MS);
    expect(started).toBeLessThan(200); // the other groups did not wait for the flood to drain
  });

  it('[S0-06] concurrencyPerGroup caps running jobs per group', async () => {
    handles.push(registerPool(CAP_POOL, [capped], { concurrency: 10, groupRetryMs: 20 }));
    await Promise.all(['a', 'b'].flatMap((group) => Array.from({ length: 8 }, (_, i) => capped.enqueue({ group, i }))));
    await waitFor(() => capDone === 16, 20_000);
    expect(maxActive.get('a')).toBe(1);
    expect(maxActive.get('b')).toBe(1);
  });
});

describe('queue global concurrency (S6-08)', () => {
  const POOL_G = 'test-fair-global';
  const OTHER_G = 'test.fairUncapped';
  let running = 0;
  let maxRunning = 0;
  let cappedDone = 0;
  let otherDone = 0;
  const limited = defineJob({
    name: 'test.fairGlobal',
    pool: POOL_G,
    payload: z.object({ group: z.string() }),
    group: (p) => p.group,
    concurrencyPerGroup: 1,
    globalConcurrency: () => 3,
    async run() {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 60));
      running--;
      cappedDone++;
    },
  });
  const other = defineJob({
    name: OTHER_G,
    pool: POOL_G,
    payload: z.object({ i: z.number() }),
    async run() {
      otherDone++;
    },
  });
  const local: PoolHandle[] = [];

  beforeAll(() => setupQueueTest(`test-${run}-g`));
  afterAll(async () => {
    await Promise.all(local.map((h) => h.close()));
    await teardownQueueTest([POOL_G]);
  });

  it('[S6-08] globalConcurrency caps one job definition across worker processes; other jobs of the pool keep running', async () => {
    // two "processes" of 10 slots each: 20 slots, 3 for the capped job
    for (let i = 0; i < 2; i++) {
      local.push(registerPool(POOL_G, [limited, other], { concurrency: 10, groupRetryMs: 20, groupRetryMaxMs: 100 }));
    }
    await Promise.all(Array.from({ length: 15 }, (_, i) => limited.enqueue({ group: `tenant-${i}` })));
    await Promise.all(Array.from({ length: 20 }, (_, i) => other.enqueue({ i })));
    await waitFor(() => cappedDone === 15 && otherDone === 20, 30_000);
    expect(maxRunning).toBe(3);
  });
});

describe('queue per-process concurrency (S6 review)', () => {
  const POOL_P = 'test-fair-process';
  let running = 0;
  let maxRunning = 0;
  let heavyDone = 0;
  let lightDone = 0;
  const heavy = defineJob({
    name: 'test.fairHeavy',
    pool: POOL_P,
    payload: z.object({ group: z.string() }),
    group: (p) => p.group,
    concurrencyPerGroup: 1,
    globalConcurrency: 24,
    perProcessConcurrency: () => 2,
    async run() {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 60));
      running--;
      heavyDone++;
    },
  });
  const light = defineJob({
    name: 'test.fairLight',
    pool: POOL_P,
    payload: z.object({ i: z.number() }),
    async run() {
      lightDone++;
    },
  });
  let handle: PoolHandle;

  beforeAll(() => setupQueueTest(`test-${run}-p`));
  afterAll(async () => {
    await handle?.close();
    await teardownQueueTest([POOL_P]);
  });

  it('[S6-F5] a third run in a process already running two goes back to delayed; the pool’s other jobs keep running', async () => {
    // one process of 10 slots: 2 for the heavy job (its per-process cap), the global cap of 24 never binds
    handle = registerPool(POOL_P, [heavy, light], { concurrency: 10, groupRetryMs: 20, groupRetryMaxMs: 100 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => heavy.enqueue({ group: `tenant-${i}` })));
    await Promise.all(Array.from({ length: 20 }, (_, i) => light.enqueue({ i })));
    await waitFor(() => heavyDone === 12 && lightDone === 20, 30_000);
    expect(maxRunning).toBe(2);
  });
});

describe('queue cap groups (S9 review)', () => {
  const POOL_S = 'test-fair-shared';
  const GROUP = 'test.heavy';
  /** Shared caps, read per attempt (each test sets them). */
  const caps = { perProcess: 2, global: 24 };
  let running = 0;
  let maxRunning = 0;
  let heavyDone = 0;
  let lightDone = 0;
  const kinds = new Set<string>();
  /** Three heavy job kinds (like a feed pass, a push run and a site feed) sharing one cap group. */
  const heavy = ['A', 'B', 'C'].map((kind) =>
    defineJob({
      name: `test.fairShared${kind}`,
      pool: POOL_S,
      payload: z.object({ group: z.string() }),
      group: (p) => p.group,
      concurrencyPerGroup: 1,
      capGroup: GROUP,
      perProcessConcurrency: () => caps.perProcess,
      globalConcurrency: () => caps.global,
      async run() {
        running++;
        maxRunning = Math.max(maxRunning, running);
        kinds.add(kind);
        await new Promise((r) => setTimeout(r, 40));
        running--;
        heavyDone++;
      },
    }),
  );
  const light = defineJob({
    name: 'test.fairSharedLight',
    pool: POOL_S,
    payload: z.object({ i: z.number() }),
    async run() {
      lightDone++;
    },
  });
  /** Hands its slots back after its heavy part, then keeps running (a nightly pass enqueueing its successor). */
  const phases: { key: string; event: 'heavyStart' | 'released' | 'end'; at: number }[] = [];
  let heavyPhase = 0;
  let maxHeavyPhase = 0;
  const handing = defineJob({
    name: 'test.fairSharedHandOver',
    pool: POOL_S,
    payload: z.object({ key: z.string() }),
    group: (p) => p.key,
    concurrencyPerGroup: 1,
    capGroup: GROUP,
    perProcessConcurrency: () => caps.perProcess,
    globalConcurrency: () => caps.global,
    async run(p, { releaseCapSlots }) {
      heavyPhase++;
      maxHeavyPhase = Math.max(maxHeavyPhase, heavyPhase);
      phases.push({ key: p.key, event: 'heavyStart', at: Date.now() });
      await new Promise((r) => setTimeout(r, 60));
      heavyPhase--;
      await releaseCapSlots?.();
      await releaseCapSlots?.(); // idempotent
      phases.push({ key: p.key, event: 'released', at: Date.now() });
      await new Promise((r) => setTimeout(r, 400));
      phases.push({ key: p.key, event: 'end', at: Date.now() });
    },
  });
  const local: PoolHandle[] = [];
  const reset = () => {
    running = 0;
    maxRunning = 0;
    heavyDone = 0;
    lightDone = 0;
    kinds.clear();
  };
  const all = [...heavy, light, handing];

  beforeAll(() => setupQueueTest(`test-${run}-s`));
  afterAll(async () => {
    await Promise.all(local.map((h) => h.close()));
    await teardownQueueTest([POOL_S]);
  });

  it('[S9-review] the jobs of one cap group never run more than the shared per-process cap together; other jobs keep running', async () => {
    Object.assign(caps, { perProcess: 2, global: 24 });
    reset();
    // One process of 10 slots: three heavy kinds × 6 jobs; counted per kind, 6 would run at once.
    local.push(registerPool(POOL_S, all, { concurrency: 10, groupRetryMs: 20, groupRetryMaxMs: 100 }));
    await Promise.all(
      heavy.flatMap((def, k) => Array.from({ length: 6 }, (_, i) => def.enqueue({ group: `t-${k}-${i}` }))),
    );
    await Promise.all(Array.from({ length: 20 }, (_, i) => light.enqueue({ i })));
    await waitFor(() => heavyDone === 18 && lightDone === 20, 30_000);
    expect(maxRunning).toBe(2);
    expect([...kinds].sort()).toEqual(['A', 'B', 'C']);
    await Promise.all(local.splice(0).map((h) => h.close()));
  });

  it('[S9-review] the jobs of one cap group share one pool-wide cap across processes', async () => {
    Object.assign(caps, { perProcess: 10, global: 3 });
    reset();
    for (let i = 0; i < 2; i++) {
      local.push(registerPool(POOL_S, all, { concurrency: 10, groupRetryMs: 20, groupRetryMaxMs: 100 }));
    }
    await Promise.all(
      heavy.flatMap((def, k) => Array.from({ length: 5 }, (_, i) => def.enqueue({ group: `u-${k}-${i}` }))),
    );
    await waitFor(() => heavyDone === 15, 30_000);
    expect(maxRunning).toBe(3);
    expect([...kinds].sort()).toEqual(['A', 'B', 'C']);
    await Promise.all(local.splice(0).map((h) => h.close()));
  });

  it('[S9-review] a job that hands its cap slots back early lets the next one start while it finishes', async () => {
    Object.assign(caps, { perProcess: 1, global: 1 });
    local.push(registerPool(POOL_S, all, { concurrency: 4, groupRetryMs: 20, groupRetryMaxMs: 100 }));
    await handing.enqueue({ key: 'first' });
    await handing.enqueue({ key: 'second' });
    await waitFor(() => phases.filter((p) => p.event === 'end').length === 2, 30_000);
    const at = (key: string, event: string) => phases.find((p) => p.key === key && p.event === event)?.at ?? NaN;
    const [a, b] = ['first', 'second'].sort((x, y) => at(x, 'heavyStart') - at(y, 'heavyStart')) as [string, string];
    // The second started after the first handed back its slot, and before the first ended: one heavy part at a time.
    expect(at(b, 'heavyStart')).toBeGreaterThanOrEqual(at(a, 'released'));
    expect(at(b, 'heavyStart')).toBeLessThan(at(a, 'end'));
    expect(maxHeavyPhase).toBe(1);
  });
});

describe('queue fair share bookkeeping', () => {
  const POOL_B = 'test-fair-book';
  const done = new Set<string>();
  const seen: string[] = [];
  const stable = defineJob({
    name: 'test.fairStable',
    pool: POOL_B,
    payload: z.object({ group: z.string(), key: z.string() }),
    group: (p) => p.group,
    jobId: (p) => p.key,
    async run(p) {
      done.add(p.key);
      seen.push(`${p.group}:${p.key}`);
    },
  });
  let redis: Redis;
  let handle: PoolHandle;

  beforeAll(async () => {
    await setupQueueTest(`test-${run}-b`);
    redis = new Redis(process.env.REDIS_QUEUE_URL as string, { protocol: 2 });
    handle = registerPool(POOL_B, [stable], { concurrency: 2 });
  });
  afterAll(async () => {
    await handle.close();
    await redis.quit();
    await teardownQueueTest([POOL_B]);
  });

  const backlog = (group: string) => redis.zcard(`test-${run}-b:fair:${POOL_B}:${group}:backlog`);

  it('[S0-06] re-enqueueing a stable job ID (redelivery, replay) does not inflate the group backlog', async () => {
    await stable.enqueue({ group: 'g', key: 'k1' });
    await waitFor(() => done.has('k1'));
    await waitFor(async () => (await backlog('g')) === 0);
    for (let i = 0; i < 5; i++) await stable.enqueue({ group: 'g', key: 'k1' }); // ignored by BullMQ (completed, kept 24 h)
    expect(await backlog('g')).toBe(0);
  });

  it('[S0-06] debounce keys are scoped to the group: one tenant cannot replace another tenant’s job', async () => {
    await stable.enqueue({ group: 'ta', key: 'shared' }, { debounceMs: 200, debounceKey: 'same' });
    await stable.enqueue({ group: 'tb', key: 'shared' }, { debounceMs: 200, debounceKey: 'same' });
    await waitFor(() => seen.includes('ta:shared') && seen.includes('tb:shared'), 10_000);
  });
});
