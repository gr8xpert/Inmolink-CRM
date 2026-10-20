import { groupRetryDelay } from '@inmolink/platform/queue';

/**
 * A discrete-time model of how feed runs reach a worker (S6-08 load test): the scheduler tick, the outbox → queue
 * hop, BullMQ priorities and the worker's per-agency and global caps — the same rules, with synthetic run durations
 * instead of real imports.
 *
 * - **Scheduler** (`imports.scheduleFeeds`, every `tickS`): queues at most `scheduleBatch` due connections per tick,
 *   at most `perAgencyPerTick` of one agency, oldest `next_run_at` first (`repo.queueDueRuns`).
 * - **Enqueue** (`platform/queue` fairness): a job's priority is its agency's backlog depth (queued + running, this one
 *   included); BullMQ takes the lowest priority first, FIFO within one.
 * - **Workers**: `processes × concurrency` slots take the best waiting job. A job whose agency already runs
 *   `perGroupCap` runs, or that finds `globalCap` runs of its kind running, goes back to delayed for
 *   `groupRetryDelay(attempt, retryBaseMs, retryMaxMs)` (with jitter), keeps its priority and goes behind the jobs of
 *   that priority already waiting (BullMQ gives a promoted job a new sequence number).
 */

export interface SimFeed {
  agency: string;
  /** Seconds the run takes once started. */
  durationS: number;
  /** Seconds after t0 the connection is due (its `next_run_at`). */
  dueAtS?: number;
}

export interface SimOptions {
  processes: number;
  concurrency: number;
  globalCap: number;
  perGroupCap: number;
  scheduleBatch: number;
  perAgencyPerTick: number;
  tickS: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Simulation step. */
  stepS: number;
  seed: number;
}

export interface SimRun {
  feed: number;
  agency: string;
  priority: number;
  enqueuedS: number;
  startedS: number;
  finishedS: number;
  /** start − enqueue */
  waitS: number;
  /**
   * The wait other agencies caused: start − max(enqueue, this agency's previous run's end). Time an agency waits
   * behind its own runs (one at a time per agency) is its own backlog, not unfairness.
   */
  tenantWaitS: number;
}

export interface SimResult {
  runs: SimRun[];
  makespanS: number;
  maxWaitS: number;
  maxTenantWaitS: number;
  p95TenantWaitS: number;
  /** Highest number of runs running at once. */
  peakRunning: number;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Job {
  feed: number;
  agency: string;
  priority: number;
  seq: number;
  enqueuedS: number;
  retryAtS: number;
  attempts: number;
  startedS?: number;
  endS?: number;
}

const p95 = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] as number;
};

export function simulate(feeds: readonly SimFeed[], o: SimOptions): SimResult {
  const random = rng(o.seed);
  const slots = o.processes * o.concurrency;
  const pending = feeds.map((f, i) => ({ i, due: f.dueAtS ?? 0 })).sort((a, b) => a.due - b.due || a.i - b.i); // queueDueRuns: next_run_at order
  const scheduled = new Set<number>();
  const backlog = new Map<string, number>();
  const activeByAgency = new Map<string, number>();
  const lastEnd = new Map<string, number>();
  const ready: Job[] = [];
  let delayed: Job[] = [];
  let running: Job[] = [];
  const runs: SimRun[] = [];
  let seq = 0;
  let nextTick = 0;
  let peak = 0;

  const step = Math.round(o.stepS * 1000);
  for (let ms = 0; runs.length < feeds.length; ms += step) {
    const t = ms / 1000;
    if (t > 24 * 3_600) throw new Error('simulation did not finish within a day');

    // 1. finished runs free their slots (worker, agency cap, global cap, backlog)
    const still: Job[] = [];
    for (const j of running) {
      if ((j.endS as number) <= t) {
        activeByAgency.set(j.agency, (activeByAgency.get(j.agency) ?? 1) - 1);
        backlog.set(j.agency, (backlog.get(j.agency) ?? 1) - 1);
        const prev = lastEnd.get(j.agency) ?? Number.NEGATIVE_INFINITY;
        const since = Math.max(j.enqueuedS, prev);
        runs.push({
          feed: j.feed,
          agency: j.agency,
          priority: j.priority,
          enqueuedS: j.enqueuedS,
          startedS: j.startedS as number,
          finishedS: j.endS as number,
          waitS: (j.startedS as number) - j.enqueuedS,
          tenantWaitS: Math.max(0, (j.startedS as number) - since),
        });
        lastEnd.set(j.agency, j.endS as number);
      } else still.push(j);
    }
    running = still;

    // 2. scheduler tick
    if (t >= nextTick) {
      nextTick += o.tickS;
      const perAgency = new Map<string, number>();
      let taken = 0;
      for (const p of pending) {
        if (taken >= o.scheduleBatch) break;
        if (scheduled.has(p.i) || p.due > t) continue;
        const f = feeds[p.i] as SimFeed;
        const n = perAgency.get(f.agency) ?? 0;
        if (n >= o.perAgencyPerTick) continue;
        perAgency.set(f.agency, n + 1);
        scheduled.add(p.i);
        taken++;
        const depth = (backlog.get(f.agency) ?? 0) + 1;
        backlog.set(f.agency, depth);
        ready.push({
          feed: p.i,
          agency: f.agency,
          priority: depth,
          seq: seq++,
          enqueuedS: t,
          retryAtS: t,
          attempts: 0,
        });
      }
    }

    // 3. delayed jobs whose retry time came go back to the prioritized set
    if (delayed.length > 0) {
      const back = delayed.filter((j) => j.retryAtS <= t);
      if (back.length > 0) {
        delayed = delayed.filter((j) => j.retryAtS > t);
        // BullMQ's promotion re-adds a delayed job to the prioritized set with a fresh counter: behind newer jobs of
        // its priority
        for (const j of back) j.seq = seq++;
        ready.push(...back);
      }
    }

    // 4. free worker slots take the best waiting job; over a cap it goes back to delayed
    let free = slots - running.length;
    while (free > 0 && ready.length > 0) {
      let best = 0;
      for (let k = 1; k < ready.length; k++) {
        const a = ready[k] as Job;
        const b = ready[best] as Job;
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = k;
      }
      const job = ready[best] as Job;
      ready.splice(best, 1);
      const agencyBusy = (activeByAgency.get(job.agency) ?? 0) >= o.perGroupCap;
      if (agencyBusy || running.length >= o.globalCap) {
        job.attempts++;
        job.retryAtS = t + groupRetryDelay(job.attempts, o.retryBaseMs, o.retryMaxMs, random()) / 1000;
        delayed.push(job);
        continue; // the slot is free again at once (moveToDelayed)
      }
      job.startedS = t;
      job.endS = t + (feeds[job.feed] as SimFeed).durationS;
      activeByAgency.set(job.agency, (activeByAgency.get(job.agency) ?? 0) + 1);
      running.push(job);
      free--;
    }
    peak = Math.max(peak, running.length);
  }

  const tenantWaits = runs.map((r) => r.tenantWaitS);
  return {
    runs,
    makespanS: Math.max(...runs.map((r) => r.finishedS)),
    maxWaitS: Math.max(...runs.map((r) => r.waitS)),
    maxTenantWaitS: Math.max(...tenantWaits),
    p95TenantWaitS: p95(tenantWaits),
    peakRunning: peak,
  };
}
