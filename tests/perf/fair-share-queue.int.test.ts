import { importsJobs, RUNS } from '@inmolink/core/modules/imports';
import { rng, type SimFeed, type SimOptions, simulate } from '@inmolink/core/test';
import { loadStackEnv } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import {
  closeQueues,
  configureQueue,
  defineJob,
  type PoolHandle,
  queueFor,
  registerPool,
} from '@inmolink/platform/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * S7-F2 (S6 review): the S6-08 fair-share model (`packages/core/src/testing/fair-share-sim.ts`) checked against the
 * real queue. In the perf project: wall-clock waits need the machine to itself (next to parallel suites the queue's
 * waits doubled). The same feeds go through real BullMQ and Redis — `platform/queue` backlog priorities, group cap,
 * pool-wide cap and per-process cap, with the run job's own settings — as jobs of 50 ms to 3 s, and through the
 * model with the same rules on the same time scale. The real queue's tenant waits, in order (median, p90, worst),
 * must stay within the model's bound, so the model the 500-feed load test relies on cannot drift from the queue.
 *
 * Scaled down: 200 feeds, 3 worker "processes" (pools in this process; per-process counts are per pool) × 2 runs,
 * a pool-wide cap of 6. One model second is `MS_PER_S` real milliseconds. The queue's own pickup latency (Redis
 * round trips, BullMQ's wake-up: tens of ms on Docker Desktop, i.e. whole model seconds here) does not scale with
 * the jobs, so the model gets it as `latencyS` — a constant (`PICKUP_MS`), not measured in this run: a model tuned
 * from the queue it then checks could follow the queue's drift instead of catching it.
 *
 * Measured (Windows + Docker Desktop, 2026-10-21, 6 runs): the real queue's waits are 1.0–1.6× the model's (worst
 * tenant 12.0–14.6 s against 10.9–12.0 s): a freed slot waits for an over-cap job's retry timer, and a retried job
 * lands on a full process about two times in three. At 25 ms per model second the queue's fixed costs weigh twice
 * as much and one run in three went past 2×. `MARGIN` is 2: the S6-08 results keep 2.5× headroom (stress mix 5.9 min
 * against 15), so a queue within 2× of the model still meets that acceptance; a model that lost a rule (a cap, the
 * priorities) is off by far more.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'imports-fair-queue-test', level: 'silent' });
const POOL = `test-imports-fair-${RUN}`;
const MS_PER_S = 50;
const PROCESSES = 3;
const PER_PROCESS = 2;
const GLOBAL_CAP = PROCESSES * PER_PROCESS;
const CONCURRENCY = 10;
/** The pools' over-cap retry (real ms; 0.4 … 4 model seconds). */
const RETRY_MS = 20;
const RETRY_MAX_MS = 200;
const FEEDS = 200;
/**
 * The queue's pickup latency given to the model: a delayed job starts this long after its due time on idle pools.
 * Measured separately (60 probes per run, 6 runs, Windows + Docker Desktop, 2026-10-21): means of 14–43 ms.
 */
const PICKUP_MS = 25;
/** Warm-up jobs before the measurement: connections up and scripts loaded, so no fixed start-up slack is needed. */
const WARM_UP = 30;
const MARGIN = 2;

/** 200 feeds: 4 huge (48–60 s), 16 medium (10–25 s), the rest small (1–8 s); agencies with 8, 2 or 1 feeds. */
function mix(seed: number): SimFeed[] {
  const random = rng(seed);
  const between = (lo: number, hi: number) => lo + random() * (hi - lo);
  const durations = Array.from({ length: FEEDS }, (_, i) =>
    i < 4 ? between(48, 60) : i < 20 ? between(10, 25) : between(1, 8),
  );
  for (let i = durations.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [durations[i], durations[j]] = [durations[j] as number, durations[i] as number];
  }
  const out: SimFeed[] = [];
  let k = 0;
  const take = (agency: string) => out.push({ agency, durationS: durations[k++] as number, dueAtS: 0 });
  for (let a = 0; a < 3; a++) for (let i = 0; i < 8; i++) take(`multi8-${a}`);
  for (let a = 0; a < 10; a++) for (let i = 0; i < 2; i++) take(`multi2-${a}`);
  for (let a = 0; k < FEEDS; a++) take(`single-${a}`);
  return out;
}

let feeds: SimFeed[] = [];
const started = new Map<number, number>();
const finished = new Map<number, number>();
let running = 0;
let peak = 0;
const activeByAgency = new Map<string, number>();
let agencyOverlap = false;

const spec = importsJobs.runFeed.spec;
const fakeRun = defineJob({
  name: `test.importsFairShare${RUN}`,
  pool: POOL,
  payload: z.object({ feed: z.number().int(), agency: z.string() }),
  jobId: (p) => `feed-${p.feed}`,
  // the run job's fair-share settings (its caps scaled with the process count)
  group: (p) => p.agency,
  concurrencyPerGroup: spec.concurrencyPerGroup,
  globalConcurrency: () => GLOBAL_CAP,
  perProcessConcurrency: () => PER_PROCESS,
  attempts: 1,
  async run(p) {
    started.set(p.feed, Date.now());
    running++;
    peak = Math.max(peak, running);
    const mine = (activeByAgency.get(p.agency) ?? 0) + 1;
    activeByAgency.set(p.agency, mine);
    if (mine > (spec.concurrencyPerGroup ?? 1)) agencyOverlap = true;
    await new Promise((r) => setTimeout(r, (feeds[p.feed] as SimFeed).durationS * MS_PER_S));
    activeByAgency.set(p.agency, (activeByAgency.get(p.agency) ?? 1) - 1);
    running--;
    finished.set(p.feed, Date.now());
  },
});

let warmedUp = 0;
const warmUp = defineJob({
  name: `test.importsFairWarmUp${RUN}`,
  pool: POOL,
  payload: z.object({ i: z.number().int() }),
  attempts: 1,
  async run() {
    warmedUp++;
  },
});

const handles: PoolHandle[] = [];

beforeAll(async () => {
  loadStackEnv('test');
  await configureQueue({ prefix: `test-fairq-${RUN}`, logger: log });
});

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  for (const name of [POOL, `${POOL}.dead`]) await queueFor(name).obliterate({ force: true });
  await closeQueues();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(done: () => boolean, timeoutMs: number, what: string) {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The wait other agencies caused each run, as the model counts it: start − max(enqueue, the agency's last end). */
function tenantWaits(runs: readonly { agency: string; startedMs: number; finishedMs: number }[], t0: number) {
  const lastEnd = new Map<string, number>();
  const out: number[] = [];
  for (const r of [...runs].sort((a, b) => a.startedMs - b.startedMs)) {
    out.push(Math.max(0, r.startedMs - Math.max(t0, lastEnd.get(r.agency) ?? Number.NEGATIVE_INFINITY)));
    lastEnd.set(r.agency, r.finishedMs);
  }
  return out;
}

/** Median, p90 and worst of the waits. */
function inOrder(waits: readonly number[]): [number, number, number] {
  const s = [...waits].sort((a, b) => a - b);
  const at = (f: number) => s[Math.min(s.length - 1, Math.ceil(s.length * f) - 1)] as number;
  return [at(0.5), at(0.9), s[s.length - 1] as number];
}

describe('fair share on the real queue (S7-F2)', () => {
  it('[S7-F2] the real queue’s tenant waits (median, p90, max) stay within the fair-share simulation’s bound', async () => {
    for (let p = 0; p < PROCESSES; p++) {
      handles.push(
        registerPool(POOL, [fakeRun, warmUp], {
          concurrency: CONCURRENCY,
          groupRetryMs: RETRY_MS,
          groupRetryMaxMs: RETRY_MAX_MS,
        }),
      );
    }
    // 1. warm the pools up (every pool's connections and scripts), nothing measured
    for (let i = 0; i < WARM_UP; i++) await warmUp.enqueue({ i }, { delayMs: 20 + i * 5 });
    await waitUntil(() => warmedUp === WARM_UP, 30_000, 'the warm-up');

    // 2. the model, with the same rules, time scale and latency
    feeds = mix(7_02);
    expect(feeds.length).toBeLessThanOrEqual(RUNS.SCHEDULE_BATCH); // one scheduler tick queues them all
    const options: SimOptions = {
      processes: PROCESSES,
      concurrency: CONCURRENCY,
      globalCap: GLOBAL_CAP,
      perProcessCap: PER_PROCESS,
      perGroupCap: spec.concurrencyPerGroup ?? 1,
      scheduleBatch: RUNS.SCHEDULE_BATCH,
      perAgencyPerTick: RUNS.SCHEDULE_PER_AGENCY,
      tickS: 60,
      retryBaseMs: (RETRY_MS / MS_PER_S) * 1_000,
      retryMaxMs: (RETRY_MAX_MS / MS_PER_S) * 1_000,
      stepS: 0.05,
      seed: 7_02,
      latencyS: PICKUP_MS / MS_PER_S,
    };
    const model = simulate(feeds, options);

    // 3. the real queue: the scheduler's tick queues every feed at once, in next_run_at order
    const t0 = Date.now();
    for (const [i, f] of feeds.entries()) await fakeRun.enqueue({ feed: i, agency: f.agency });
    await waitUntil(() => finished.size === feeds.length, 180_000, 'the feed runs');

    const real = inOrder(
      tenantWaits(
        feeds.map((f, i) => ({
          agency: f.agency,
          startedMs: started.get(i) as number,
          finishedMs: finished.get(i) as number,
        })),
        t0,
      ),
    );
    const modelled = inOrder(model.runs.map((r) => r.tenantWaitS * MS_PER_S));
    const round = (xs: readonly number[]) => xs.map((x) => Math.round(x)).join(' / ');
    console.info(
      `[S7-F2] ${feeds.length} feeds, pickup latency ${PICKUP_MS} ms (model); tenant wait median / p90 / max: ` +
        `real ${round(real)} ms, model ${round(modelled)} ms; peak ${peak} running (model ${model.peakRunning})`,
    );

    // the caps hold
    expect(peak).toBeLessThanOrEqual(GLOBAL_CAP);
    expect(model.peakRunning).toBeLessThanOrEqual(GLOBAL_CAP);
    expect(agencyOverlap).toBe(false);
    // the waits, in order: within the model's bound — and the model not far above the queue either
    for (const [k, wait] of real.entries()) {
      const m = modelled[k] as number;
      expect(wait).toBeLessThanOrEqual(m * MARGIN);
      expect(wait).toBeGreaterThanOrEqual(m / MARGIN);
    }
  });
});
