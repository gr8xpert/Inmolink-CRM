import { describe, expect, it } from 'vitest';
import { median, SOAK, type SoakSample, seriesKind, slope, soakText, soakVerdict } from './lib/soak';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1);

/** One sample a minute for `hours` (+ the warm-up), each series from `f(minute)`. */
function run(hours: number, f: (m: number) => Record<string, number>): SoakSample[] {
  const total = SOAK.warmupMs / MIN + hours * 60;
  return Array.from({ length: total + 1 }, (_, m) => ({ t: T0 + m * MIN, values: f(m) }));
}

const MB = 1_048_576;
/** A steady service: memory oscillating around 300 MB (GC saw-tooth), a pool of 20 connections, ±2. */
const steady = (m: number) => ({
  'mem:api': (300 + 20 * Math.sin(m / 7)) * MB,
  'pg:app_user': 20 + (m % 5) - 2,
  'pg:total': 60 + (m % 3),
  'redis:queue:clients': 40,
  'redis:cache:mem': 120 * MB,
});
const LIMITS = { 'pg:total': 200, 'redis:queue:clients': 10_000 };

describe('soak verdict (S16-01)', () => {
  it('[S16-01] 24 h at 50 % with steady memory and pools passes, and says it is the acceptance soak', () => {
    const v = soakVerdict(run(24, steady), LIMITS, { loadUntil: Number.MAX_SAFE_INTEGER });
    expect(v.acceptance).toBe(true);
    expect(v.pass).toBe(true);
    expect(v.series.map((s) => s.series)).toEqual([
      'mem:api',
      'pg:app_user',
      'pg:total',
      'redis:cache:mem',
      'redis:queue:clients',
    ]);
    expect(soakText(v)).toContain('(the 24-hour acceptance soak)');
    expect(soakText(v)).toContain('PASS');
  });

  it('[S16-01] memory growth fails: a leak of 15 % over the day, or a slow leak whose trend adds > 10 % a day', () => {
    const leak = soakVerdict(
      run(24, (m) => ({ ...steady(m), 'mem:api': (300 + (45 * m) / (24 * 60)) * MB })),
      LIMITS,
    );
    expect(leak.pass).toBe(false);
    expect(leak.series.find((s) => s.series === 'mem:api')?.reason).toMatch(/grew 1\d\.\d %/);
    // An 8-hour run growing 4 %: under 10 % in the run, but 12 % a day at that pace.
    const slow = soakVerdict(
      run(8, (m) => ({ ...steady(m), 'mem:api': (300 + (12 * m) / (8 * 60)) * MB })),
      LIMITS,
    );
    expect(slow.acceptance).toBe(false);
    expect(slow.series.find((s) => s.series === 'mem:api')?.reason).toMatch(/trend adds/);
    // A 15-minute slice with a little jitter is not extrapolated to a day.
    const slice = soakVerdict(
      Array.from({ length: 90 }, (_, i) => ({
        t: T0 + i * 10_000,
        values: { 'mem:x': (38 + (i % 7 === 0 ? 1 : 0) + i / 900) * MB },
      })),
      {},
      { warmupMs: 60_000 },
    );
    expect(slice.pass).toBe(true);
    expect(soakText(slow)).toContain('NOT the 24-hour acceptance soak');
  });

  it('[S16-01] connection exhaustion fails: a pool that keeps opening connections, or one near its limit', () => {
    const creeping = soakVerdict(
      run(24, (m) => ({ ...steady(m), 'pg:app_user': 20 + Math.floor(m / 60) })),
      LIMITS,
    );
    expect(creeping.series.find((s) => s.series === 'pg:app_user')?.reason).toMatch(/rose from/);
    const full = soakVerdict(
      run(24, (m) => ({ ...steady(m), 'pg:total': m === 900 ? 165 : 60 })),
      LIMITS,
    );
    expect(full.series.find((s) => s.series === 'pg:total')?.reason).toMatch(/peaked at 165 of 200/);
    expect(full.pass).toBe(false);
    // A burst inside the run that comes back is no leak.
    const burst = soakVerdict(
      run(24, (m) => ({ ...steady(m), 'pg:app_user': m > 600 && m < 640 ? 60 : 20 })),
      LIMITS,
    );
    expect(burst.pass).toBe(true);
  });

  it('[S16-01] a series that vanishes, appears mid-run or has a gap fails; per-role sessions may come and go', () => {
    // The api container restarts at hour 12 under a new name (a redeploy): the old series stops, a new one starts.
    const redeploy = soakVerdict(
      run(24, (m) => {
        const { 'mem:api': mem, ...rest } = steady(m);
        return m < 30 + 12 * 60 ? { ...rest, 'mem:api': mem as number } : { ...rest, 'mem:api-2': mem as number };
      }),
      LIMITS,
    );
    expect(redeploy.series.find((s) => s.series === 'mem:api')?.reason).toMatch(/no samples in the last window/);
    expect(redeploy.series.find((s) => s.series === 'mem:api-2')?.reason).toMatch(/appeared mid-run/);
    // A probe down for 10 minutes.
    const gap = soakVerdict(
      run(24, (m) => {
        const v: Record<string, number> = steady(m);
        if (m > 600 && m < 610) delete v['redis:cache:mem'];
        return v;
      }),
      LIMITS,
    );
    expect(gap.series.find((s) => s.series === 'redis:cache:mem')?.reason).toMatch(/a gap of \d+ s/);
    // A role with sessions only now and then (app_auth on logins) counts 0 in between: no failure.
    const auth = soakVerdict(
      run(24, (m) => ({ ...steady(m), ...(m % 10 === 0 ? { 'pg:app_auth': 1 } : {}) })),
      LIMITS,
    );
    expect(auth.pass).toBe(true);
  });

  it('[S16-01] samples after the load ended are not judged, and only a run cut at the load end is the acceptance soak', () => {
    // k6 stops at 24 h 05 min; the sampler goes on idle for an hour, memory dropping back: the leak is still seen.
    const leakThenIdle = run(25, (m) => ({
      ...steady(m),
      'mem:api': (m <= 30 + 24 * 60 ? 300 + (45 * m) / (24 * 60) : 300) * MB,
    }));
    const loadUntil = T0 + (5 + 24 * 60) * MIN;
    const cut = soakVerdict(leakThenIdle, LIMITS, { loadUntil });
    expect(cut.series.find((s) => s.series === 'mem:api')?.ok).toBe(false);
    expect(cut.acceptance).toBe(true);
    expect(soakVerdict(leakThenIdle, LIMITS).acceptance).toBe(false);
  });

  it('[S16-01] the warm-up is not judged, and a run too short to compare is refused', () => {
    // Pools filling from 0 to 20 in the first 30 minutes are the warm-up, not growth.
    const filling = soakVerdict(
      run(6, (m) => ({ ...steady(m), 'pg:app_user': Math.min(20, m) })),
      LIMITS,
    );
    expect(filling.pass).toBe(true);
    expect(() => soakVerdict(run(0, steady), LIMITS)).toThrow(/too few samples/);
    expect(() => soakVerdict([], LIMITS)).toThrow(/no samples/);
  });

  it('[S16-01] helpers: series kinds, median and slope', () => {
    expect(seriesKind('mem:worker-imports')).toBe('memory');
    expect(seriesKind('redis:cache:mem')).toBe('memory');
    expect(seriesKind('pg:app_public')).toBe('connections');
    expect(seriesKind('redis:limits:clients')).toBe('connections');
    expect(seriesKind('pgbouncer:cl_waiting')).toBe('other');
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(
      slope([
        [0, 1],
        [1, 3],
        [2, 5],
      ]),
    ).toBeCloseTo(2);
  });
});

describe('soak sampler probes (S16-01)', () => {
  it('[S16-01] reads memory from docker stats, /proc and tasklist, and Redis INFO fields', async () => {
    const { parseDockerMem, parseProcStatusRss, parseTasklistRss, parseRedisInfo } = await import('./lib/soak');
    expect(parseDockerMem('123.5MiB / 2GiB')).toBe(123.5 * 1_048_576);
    expect(parseDockerMem('1.2GiB / 8GiB')).toBeCloseTo(1.2 * 1_073_741_824);
    expect(parseDockerMem('512KiB / 1GiB')).toBe(512 * 1024);
    expect(() => parseDockerMem('-- / --')).toThrow(/unreadable/);
    expect(parseProcStatusRss('Name:\tnode\nVmRSS:\t  204800 kB\nThreads: 11\n')).toBe(204_800 * 1024);
    expect(parseTasklistRss('"node.exe","1234","Console","1","123,456 K"')).toBe(123_456 * 1024);
    expect(parseRedisInfo('# Clients\r\nconnected_clients:42\r\nmaxclients:10000\r\n')).toEqual({
      connected_clients: '42',
      maxclients: '10000',
    });
  });
});
