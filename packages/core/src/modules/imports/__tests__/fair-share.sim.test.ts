import { importsEnv } from '@inmolink/platform/config';
import { describe, expect, it } from 'vitest';
import { RUNS } from '../config';
import { rng, type SimFeed, type SimOptions, simulate } from './fair-share-sim';

/**
 * S6-08 load test: 500 feeds due at the same moment, through a model of the real scheduling rules (scheduler tick
 * batches, per-agency backlog priorities, one run per agency, `IMPORT_MAX_CONCURRENT_RUNS` across the pool) with
 * synthetic durations — no HTTP, no database. Sizes follow S6-02's measurements: a 100 MB feed (≈ 18k listings)
 * takes 48–57 s; an unchanged re-import is cheaper; most agencies' feeds hold a few hundred listings.
 */

const FIFTEEN_MIN_S = 15 * 60;

/** Production defaults: scheduler constants, the env default cap, `registerPool` defaults (250 ms … 5 s). */
const options: SimOptions = {
  processes: 4,
  concurrency: 10,
  globalCap: importsEnv.IMPORT_MAX_CONCURRENT_RUNS.parse(undefined),
  perGroupCap: 1,
  scheduleBatch: RUNS.SCHEDULE_BATCH,
  perAgencyPerTick: RUNS.SCHEDULE_PER_AGENCY,
  tickS: 60,
  retryBaseMs: 250,
  retryMaxMs: 5_000,
  stepS: 0.05,
  seed: 6_08,
};

interface Mix {
  huge: number;
  medium: number;
  /** Agencies with several feeds: [agencies, feeds each]. */
  multi: [number, number][];
  /** One agency with this many feeds, all due first (an aggregator). */
  flood?: number;
  /**
   * The platform's steady load on top (perf review): at 5,000 agencies ≈ 120k runs a day ≈ 83 a minute of 2–11 s
   * (≈ 6.5 s average) — the pool is already about half busy when the 500 arrive. Spread over 30 minutes.
   */
  background?: boolean;
}

const BACKGROUND_PER_MIN = 83;
const BACKGROUND_MIN = 30;

/** 500 feeds: `huge` 100 MB feeds (48–60 s), `medium` (10–25 s), the rest small (1–8 s), shuffled over agencies. */
function feeds(mix: Mix, seed: number): SimFeed[] {
  const random = rng(seed);
  const between = (lo: number, hi: number) => lo + random() * (hi - lo);
  const durations = Array.from({ length: 500 }, (_, i) =>
    i < mix.huge ? between(48, 60) : i < mix.huge + mix.medium ? between(10, 25) : between(1, 8),
  );
  for (let i = durations.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [durations[i], durations[j]] = [durations[j] as number, durations[i] as number];
  }
  const out: SimFeed[] = [];
  let k = 0;
  const take = (agency: string, due = 0) => out.push({ agency, durationS: durations[k++] as number, dueAtS: due });
  if (mix.flood) for (let i = 0; i < mix.flood; i++) take('aggregator', -1); // due before everyone else
  mix.multi.forEach(([agencies, each], m) => {
    for (let a = 0; a < agencies; a++) for (let i = 0; i < each; i++) take(`multi-${m}-${a}`);
  });
  for (let a = 0; k < durations.length; a++) take(`single-${a}`);
  if (mix.background) {
    const n = BACKGROUND_PER_MIN * BACKGROUND_MIN;
    for (let i = 0; i < n; i++) {
      out.push({ agency: `bg-${i}`, durationS: between(2, 11), dueAtS: (i / n) * BACKGROUND_MIN * 60 - 120 });
    }
  }
  return out;
}

const minutes = (s: number) => Math.round((s / 60) * 10) / 10;

describe('fair scheduler', () => {
  it('[S6-08] with 500 simultaneous feeds (10 × 100 MB, 40 medium, 450 small) on top of the steady load no tenant waits 15 min in the queue', () => {
    const result = simulate(
      feeds(
        {
          huge: 10,
          medium: 40,
          background: true,
          multi: [
            [25, 2],
            [5, 10],
          ],
        },
        1,
      ),
      options,
    );
    console.info(
      `[S6-08] 500 feeds: max tenant wait ${minutes(result.maxTenantWaitS)} min (p95 ${minutes(result.p95TenantWaitS)}),` +
        ` max run wait ${minutes(result.maxWaitS)} min, all done in ${minutes(result.makespanS)} min, peak ${result.peakRunning} running`,
    );
    expect(result.runs.filter((r) => !r.agency.startsWith('bg-'))).toHaveLength(500);
    expect(result.peakRunning).toBeLessThanOrEqual(options.globalCap);
    expect(result.maxTenantWaitS).toBeLessThan(FIFTEEN_MIN_S);
    expect(result.maxWaitS).toBeLessThan(FIFTEEN_MIN_S);
  });

  it('[S6-08] stress: 50 × 100 MB feeds and an aggregator with 40 feeds due first — still no tenant waits 15 min', () => {
    const result = simulate(feeds({ huge: 50, medium: 50, multi: [[20, 2]], flood: 40, background: true }, 2), options);
    console.info(
      `[S6-08] stress: max tenant wait ${minutes(result.maxTenantWaitS)} min (p95 ${minutes(result.p95TenantWaitS)}),` +
        ` all done in ${minutes(result.makespanS)} min`,
    );
    expect(result.runs.filter((r) => !r.agency.startsWith('bg-'))).toHaveLength(500);
    expect(result.maxTenantWaitS).toBeLessThan(FIFTEEN_MIN_S);
  });

  it('[S6-08] fair share: an aggregator flooding 40 feeds does not push the other agencies back', () => {
    const base = { huge: 10, medium: 40, multi: [[25, 2]] as [number, number][] };
    const without = simulate(feeds(base, 3), options);
    const withFlood = simulate(feeds({ ...base, flood: 40 }, 3), options);
    const others = (r: typeof without) =>
      Math.max(...r.runs.filter((x) => x.agency !== 'aggregator').map((x) => x.tenantWaitS));
    // the aggregator runs one feed at a time; everyone else's first run is not queued behind its backlog
    const aggregator = withFlood.runs.filter((r) => r.agency === 'aggregator');
    expect(aggregator.every((r, i, all) => i === 0 || r.startedS >= (all[i - 1] as typeof r).finishedS)).toBe(true);
    // others wait at most about one more long run than without the flood (one slot of the cap is the aggregator's)
    expect(others(withFlood)).toBeLessThanOrEqual(others(without) + 60);
    expect(others(withFlood)).toBeLessThan(FIFTEEN_MIN_S);
  });
});
