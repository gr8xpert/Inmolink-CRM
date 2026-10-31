import { describe, expect, it } from 'vitest';
import {
  agenciesIn,
  changeDueMs,
  droppedPrice,
  feedMix,
  IMPORT_PROFILES,
  IMPORT_STORM,
  importReport,
  importSummaryText,
  kyeroFeedXml,
  MATCHING_PROFILES,
  MATCHING_STORM,
  matchingReport,
  matchingSummaryText,
  percentile,
  QueueAgeTracker,
  queueAgeOf,
  type RunSample,
  resolveImportProfile,
  resolveMatchingProfile,
} from '../../scripts/perf/lib/storm';

const MIN = 60_000;
const run = (agencyId: string, created: number, started: number | null, finished: number | null, state: string) =>
  ({
    runId: `${agencyId}-${created}`,
    agencyId,
    createdAtMs: created,
    startedAtMs: started,
    finishedAtMs: finished,
    state,
  }) satisfies RunSample;

describe('storm targets and profiles', () => {
  it('[S16-01] the targets are PLAN §15’s: 500 feeds within 15 min; 10k changes in 5 min against 1M profiles, < 10 min', () => {
    expect(IMPORT_STORM).toEqual({ feeds: 500, maxQueueAgeMs: 15 * MIN });
    expect(MATCHING_STORM).toEqual({ changes: 10_000, windowMs: 5 * MIN, maxProcessMs: 10 * MIN, profiles: 1_000_000 });
    expect(IMPORT_PROFILES.staging).toMatchObject(IMPORT_STORM);
    expect(MATCHING_PROFILES.staging).toMatchObject(MATCHING_STORM);
    // the smoke slice keeps the budgets, with smaller numbers
    expect(IMPORT_PROFILES.smoke.maxQueueAgeMs).toBe(IMPORT_STORM.maxQueueAgeMs);
    expect(IMPORT_PROFILES.smoke.feeds).toBeLessThan(IMPORT_STORM.feeds);
    expect(MATCHING_PROFILES.smoke.maxProcessMs).toBe(MATCHING_STORM.maxProcessMs);
    expect(MATCHING_PROFILES.smoke.changes).toBeLessThan(MATCHING_STORM.changes);
  });

  it('[S16-01] the staging profile refuses overrides; smoke takes them; unknown profiles and bad numbers are refused', () => {
    expect(resolveImportProfile().name).toBe('smoke');
    expect(resolveImportProfile('staging')).toMatchObject({ name: 'staging', feeds: 500 });
    expect(() => resolveImportProfile('staging', { feeds: 10 })).toThrow(/acceptance check: no --feeds/);
    expect(() => resolveMatchingProfile('staging', { maxProcessMs: 1 })).toThrow(/no --max-process-ms/);
    expect(resolveImportProfile('smoke', { feeds: 50 }).feeds).toBe(50);
    expect(resolveMatchingProfile('smoke', { changes: 30, agencies: 3 })).toMatchObject({ changes: 30, agencies: 3 });
    expect(() => resolveImportProfile('soak')).toThrow(/--profile must be one of smoke, staging/);
    expect(() => resolveMatchingProfile('smoke', { changes: 0 })).toThrow(/--changes must be a positive integer/);
    expect(resolveImportProfile('staging', { feeds: undefined }).feeds).toBe(500);
  });
});

describe('import storm', () => {
  it('[S16-01] 500 feeds: agencies with 8 and 2 feeds plus singles, 5 huge and 20 medium spread over tenants', () => {
    const mix = feedMix(500, IMPORT_PROFILES.staging.sizes);
    expect(mix).toHaveLength(500);
    expect(new Set(mix.map((f) => f.feed)).size).toBe(500);
    const perAgency = new Map<number, number>();
    for (const f of mix) perAgency.set(f.agency, (perAgency.get(f.agency) ?? 0) + 1);
    const counts = [...perAgency.values()];
    expect(counts.filter((n) => n === 8)).toHaveLength(7);
    expect(counts.filter((n) => n === 2)).toHaveLength(25);
    expect(agenciesIn(mix)).toBe(7 + 25 + (500 - 56 - 50));
    expect(mix.filter((f) => f.size === 'huge')).toHaveLength(5);
    expect(mix.filter((f) => f.size === 'medium')).toHaveLength(20);
    // never two huge feeds in one agency
    const hugeOwners = mix.filter((f) => f.size === 'huge').map((f) => f.agency);
    expect(new Set(hugeOwners).size).toBe(hugeOwners.length);
    expect(mix.find((f) => f.size === 'huge')?.listings).toBe(5_000);
    // a small slice: still a multi-feed agency, one huge and one medium
    const smoke = feedMix(20, IMPORT_PROFILES.smoke.sizes);
    expect(smoke.filter((f) => f.size === 'huge')).toHaveLength(1);
    expect(agenciesIn(smoke)).toBe(19);
    expect(() => feedMix(0, IMPORT_PROFILES.smoke.sizes)).toThrow(RangeError);
  });

  it('[S16-01] a tenant’s queue age is its longest wait, a run still waiting counting with its age so far', () => {
    expect(queueAgeOf(run('a', 1_000, 4_000, null, 'RUNNING'), 9_000)).toBe(3_000);
    expect(queueAgeOf(run('a', 1_000, null, null, 'QUEUED'), 9_000)).toBe(8_000);
    const t = new QueueAgeTracker();
    // sample 1 at 10 min: a started after 1 min; b waiting 10 min; c waiting 2 min
    t.observe(10 * MIN, [
      run('a', 0, 1 * MIN, null, 'RUNNING'),
      run('b', 0, null, null, 'QUEUED'),
      run('c', 8 * MIN, null, null, 'QUEUED'),
    ]);
    expect(t.curve.at(-1)).toEqual([10 * MIN, 10 * MIN]);
    // sample 2 at 20 min: b started at 16 min (16 min of age, worse than the 10 seen), c at 9 min (1 min < 2 seen)
    t.observe(20 * MIN, [
      run('a', 0, 1 * MIN, 5 * MIN, 'SUCCEEDED'),
      run('b', 0, 16 * MIN, null, 'RUNNING'),
      run('c', 8 * MIN, 9 * MIN, 12 * MIN, 'SUCCEEDED'),
    ]);
    expect(Object.fromEntries(t.worstByTenant)).toEqual({ a: 1 * MIN, b: 16 * MIN, c: 2 * MIN });
    expect(t.curve.at(-1)).toEqual([20 * MIN, 0]);
  });

  it('[S16-01] the verdict: the worst tenant over 15 min fails; every run ended and none failed passes', () => {
    const p = resolveImportProfile('smoke', { feeds: 3 });
    const mix = feedMix(3, p.sizes);
    const measured = { triggeredAtMs: 0, endedAtMs: 30 * MIN, connections: 3, timedOut: false, feedRequests: 3 };
    const ok = new QueueAgeTracker();
    ok.observe(30 * MIN, [
      run('a', 1 * MIN, 2 * MIN, 4 * MIN, 'SUCCEEDED'),
      run('b', 1 * MIN, 10 * MIN, 12 * MIN, 'SUCCEEDED'),
      run('c', 1 * MIN, 15 * MIN, 20 * MIN, 'SUCCEEDED'),
    ]);
    const pass = importReport(p, mix, ok, measured);
    expect(pass).toMatchObject({
      pass: true,
      drainMs: 20 * MIN,
      scheduledMs: 1 * MIN,
      worstTriggerToStartMs: 15 * MIN,
      runs: { seen: 3, succeeded: 3, failed: 0, unfinished: 0, missing: 0 },
      queueAgeMs: { worst: 14 * MIN, worstTenant: 'c' },
    });
    expect(importSummaryText(pass)).toMatch(/NOT the acceptance profile[\s\S]*PASS: every threshold held/);

    const slow = new QueueAgeTracker();
    slow.observe(30 * MIN, [run('a', 0, 2 * MIN, 4 * MIN, 'SUCCEEDED'), run('b', 0, 16 * MIN, 18 * MIN, 'FAILED')]);
    const fail = importReport(p, mix, slow, measured);
    expect(fail.pass).toBe(false);
    expect(fail.failedThresholds).toEqual([
      'worst tenant queue age 16 min 00 s > 15 min 00 s',
      'worst trigger → started 16 min 00 s > 15 min 00 s',
      '1 connections never got a run',
      '1 runs FAILED',
    ]);
    expect(importSummaryText(fail)).toMatch(/FAIL: worst tenant queue age 16 min 00 s/);

    const stuck = new QueueAgeTracker();
    stuck.observe(30 * MIN, [run('a', 0, null, null, 'QUEUED')]);
    const timedOut = importReport(p, feedMix(1, p.sizes), stuck, { ...measured, connections: 1, timedOut: true });
    expect(timedOut.failedThresholds).toEqual(
      expect.arrayContaining(['worst tenant queue age 30 min 00 s > 15 min 00 s', '1 runs not finished']),
    );
    expect(timedOut.drainMs).toBe(30 * MIN);
  });

  it('[S16-01] the verdict also judges trigger → started: a slow scheduler fails even when queue ages are short', () => {
    const p = resolveImportProfile('smoke', { feeds: 2 });
    const measured = { triggeredAtMs: 0, endedAtMs: 30 * MIN, connections: 2, timedOut: false, feedRequests: 2 };
    const lagging = new QueueAgeTracker();
    // run b is queued 10 min after the trigger and starts 6 min later: queue age 6 min, the tenant waited 16 min
    lagging.observe(30 * MIN, [
      run('a', 0, 1 * MIN, 2 * MIN, 'SUCCEEDED'),
      run('b', 10 * MIN, 16 * MIN, 18 * MIN, 'SUCCEEDED'),
    ]);
    const r = importReport(p, feedMix(2, p.sizes), lagging, measured);
    expect(r.queueAgeMs.worst).toBe(6 * MIN);
    expect(r.worstTriggerToStartMs).toBe(16 * MIN);
    expect(r.failedThresholds).toEqual(['worst trigger → started 16 min 00 s > 15 min 00 s']);
    expect(r.pass).toBe(false);
    // exactly on the budget passes
    const onTime = new QueueAgeTracker();
    onTime.observe(30 * MIN, [
      run('a', 0, 1 * MIN, 2 * MIN, 'SUCCEEDED'),
      run('b', 9 * MIN, 15 * MIN, 18 * MIN, 'SUCCEEDED'),
    ]);
    expect(importReport(p, feedMix(2, p.sizes), onTime, measured).pass).toBe(true);
  });

  it('[S16-01] the staging summary says it is the acceptance profile', () => {
    const p = resolveImportProfile('staging');
    const t = new QueueAgeTracker();
    t.observe(MIN, []);
    const r = importReport(p, feedMix(500, p.sizes), t, {
      triggeredAtMs: 0,
      endedAtMs: MIN,
      connections: 500,
      timedOut: false,
      feedRequests: 0,
    });
    expect(importSummaryText(r)).toMatch(/^import storm — 500 feeds .* \(the acceptance profile\)/);
  });

  it('[S16-01] a storm feed is Kyero v3 with stable refs, no images, and the run tag in its text', () => {
    const xml = kyeroFeedXml(7, 3, 'r1<&>');
    expect(xml.match(/<property>/g)).toHaveLength(3);
    expect(xml).toContain('<feed_version>3</feed_version>');
    expect(xml).toContain('<ref>STORM-7-0</ref>');
    expect(xml).toContain('<ref>STORM-7-2</ref>');
    expect(xml).toContain('run r1&lt;&amp;&gt;.');
    expect(xml).not.toContain('<image');
    expect(kyeroFeedXml(7, 3, 'x')).toBe(kyeroFeedXml(7, 3, 'x'));
  });
});

describe('matching storm', () => {
  it('[S16-01] changes are paced evenly over the window and drop the price by 1 %', () => {
    expect(changeDueMs(0, 10_000, 5 * MIN)).toBe(0);
    expect(changeDueMs(5_000, 10_000, 5 * MIN)).toBe(2.5 * MIN);
    expect(changeDueMs(9_999, 10_000, 5 * MIN)).toBeLessThan(5 * MIN);
    expect(changeDueMs(0, 1, 5 * MIN)).toBe(0);
    expect(droppedPrice(50_000_000)).toBe(49_500_000);
    expect(droppedPrice(1_000_050)).toBe(990_000);
    expect(droppedPrice(10_000)).toBe(9_900);
    expect(droppedPrice(50)).toBe(0);
  });

  it('[S16-01] processed = first change → last match; unmatched, slow or under-provisioned runs fail', () => {
    const p = resolveMatchingProfile('smoke', { changes: 3, profiles: 100 });
    const base = {
      planned: 3,
      profiles: 100,
      provisioned: 40,
      agencies: 2,
      applyErrors: 0,
      timedOut: false,
      endedAtMs: 12 * MIN,
      alerts: 9,
    };
    const ok = matchingReport(
      p,
      [
        { listingId: 'a', changedAtMs: 0, matchedAtMs: 10_000 },
        { listingId: 'b', changedAtMs: 30_000, matchedAtMs: 45_000 },
        { listingId: 'c', changedAtMs: 60_000, matchedAtMs: 2 * MIN },
      ],
      base,
    );
    expect(ok).toMatchObject({
      pass: true,
      applied: 3,
      matched: 3,
      applySpanMs: MIN,
      processMs: 2 * MIN,
      tailMs: MIN,
      lagMs: { p50: 15_000, p95: MIN, max: MIN },
    });
    expect(matchingSummaryText(ok)).toMatch(/matched 3\/3: processed in 2 min 00 s[\s\S]*PASS/);

    const bad = matchingReport(
      p,
      [
        { listingId: 'a', changedAtMs: 0, matchedAtMs: 11 * MIN },
        { listingId: 'b', changedAtMs: 2 * MIN, matchedAtMs: null },
      ],
      { ...base, profiles: 50, applyErrors: 1 },
    );
    expect(bad.pass).toBe(false);
    expect(bad.failedThresholds).toEqual([
      '1 of 3 changes not applied',
      'changes took 2 min 00 s > 1 min 00 s (+10 %)',
      '1 changes not matched',
      'processed in 12 min 00 s > 10 min 00 s',
      '50 client profiles < 100',
    ]);
    expect(bad.lagMs.max).toBe(11 * MIN);
  });

  it('[S16-01] the staging summary says it is the acceptance profile; percentiles are nearest-rank', () => {
    const p = resolveMatchingProfile('staging');
    const r = matchingReport(p, [], {
      planned: p.changes,
      profiles: p.profiles,
      provisioned: 0,
      agencies: 0,
      applyErrors: 0,
      timedOut: false,
      endedAtMs: 0,
      alerts: 0,
    });
    expect(matchingSummaryText(r)).toMatch(/^matching storm — 10000 listing changes .* \(the acceptance profile\)/);
    expect(r.pass).toBe(false);
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(
      percentile(
        Array.from({ length: 100 }, (_, i) => i + 1),
        0.95,
      ),
    ).toBe(95);
  });
});
