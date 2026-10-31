/**
 * Soak verdict (S16-01, PLAN §15 "Soak: 24 h at 50 % load; no memory growth, no connection exhaustion"). Pure — no
 * k6 or Node module — so `scripts/perf/soak-sampler.ts` and Vitest (`soak.test.ts`) run the same code.
 *
 * The sampler records one sample per interval: a value per series (`mem:<process>` resident bytes, `pg:<role>`
 * connections, `pg:total`, `redis:<name>:clients`, `redis:<name>:mem`). The verdict compares the first and the last
 * window of the run after the warm-up (medians, so one GC pause or one burst does not decide) and fits a line through
 * all of it:
 * - **memory** (`mem:*`, `redis:*:mem`) grows by no more than `memGrowth` (10 %) from the first to the last window,
 *   and, on a run of at least `trendMinMs` (6 h), its slope would not add more than that again in another 24 h — a
 *   slow leak shows in both (a shorter slice is projected over its own span only: a minute of jitter extrapolated to
 *   a day says nothing);
 * - **connections** (`pg:*`, `redis:*:clients`) never reach `connCeiling` (80 %) of their limit, and the last
 *   window's median stays within `connGrowth` (20 %, at least 5 connections) of the first: pools hold, nothing leaks.
 */

export interface SoakSample {
  /** Milliseconds since the epoch. */
  t: number;
  values: Record<string, number>;
}

export interface SoakLimits {
  /** Hard limits per connection series (e.g. `pg:total` → max_connections, `redis:queue:clients` → maxclients). */
  [series: string]: number;
}

export const SOAK = {
  /** Not judged: pools fill and caches warm (the k6 soak profile's own warm-up is 5 min). */
  warmupMs: 30 * 60_000,
  /** Length of the first and the last window compared. */
  windowMs: 60 * 60_000,
  memGrowth: 0.1,
  connGrowth: 0.2,
  connGrowthMin: 5,
  connCeiling: 0.8,
  /**
   * Judged span of the acceptance soak: the k6 soak profiles run 5 min ramp + 24 h steady and the sampler starts with
   * them, so 24 h 05 min less the 30-min warm-up leaves 23 h 35 min; 23 h or more is the acceptance soak, shorter runs
   * are reported as a slice.
   */
  acceptanceMs: 23 * 3_600_000,
  /**
   * The load's end (ms since the epoch): samples after it are not judged, so an idle tail after k6 stops cannot make
   * the last window look flat. Infinity: every sample.
   */
  loadUntil: Number.POSITIVE_INFINITY,
  /** A gap between a series' samples longer than this many sampling intervals fails it (probe down, restart). */
  maxGapIntervals: 3,
  /** Shortest judged span whose fitted slope is projected over 24 h. */
  trendMinMs: 6 * 3_600_000,
} as const;

export type SoakOptions = { [K in keyof typeof SOAK]: number };

export type SeriesKind = 'memory' | 'connections' | 'other';

export function seriesKind(name: string): SeriesKind {
  if (name.startsWith('mem:') || /^redis:[^:]+:mem$/.test(name)) return 'memory';
  if (name.startsWith('pg:') || /^redis:[^:]+:clients$/.test(name)) return 'connections';
  return 'other';
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Least-squares slope, units per millisecond. */
export function slope(points: readonly [number, number][]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((t, p) => t + p[0], 0) / n;
  const my = points.reduce((t, p) => t + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export interface SeriesVerdict {
  series: string;
  kind: SeriesKind;
  first: number;
  last: number;
  max: number;
  /** Relative change first → last window. */
  growth: number;
  /**
   * Projected change at the fitted slope, relative to the first window: over 24 h on a run of `trendMinMs` or more,
   * over the run's own span on a shorter slice.
   */
  projected24h: number;
  limit: number | null;
  ok: boolean;
  reason: string | null;
}

export interface SoakVerdict {
  /** Judged span (after warm-up), ms. */
  spanMs: number;
  samples: number;
  /** True when the run is as long as the acceptance soak (24 h after warm-up). */
  acceptance: boolean;
  series: SeriesVerdict[];
  pass: boolean;
}

export function soakVerdict(
  samples: readonly SoakSample[],
  limits: SoakLimits = {},
  options: Partial<SoakOptions> = {},
): SoakVerdict {
  const o = { ...SOAK, ...options };
  if (samples.length === 0) throw new Error('no samples');
  const start = (samples[0] as SoakSample).t + o.warmupMs;
  const judged = samples.filter((s) => s.t >= start && s.t <= o.loadUntil);
  const end = judged.length ? (judged[judged.length - 1] as SoakSample).t : start;
  const spanMs = Math.max(0, end - start);
  // Two windows that do not overlap: on a short slice each is a third of the span.
  const windowMs = Math.min(o.windowMs, spanMs / 3);
  if (judged.length < 6 || windowMs <= 0) {
    throw new Error(
      `too few samples after the warm-up (${judged.length} in ${Math.round(spanMs / 1000)} s): run longer`,
    );
  }
  const names = [...new Set(judged.flatMap((s) => Object.keys(s.values)))].sort();
  const interval = median(judged.slice(1).map((s, i) => s.t - (judged[i] as SoakSample).t));
  const series = names.map((name): SeriesVerdict => {
    const kind = seriesKind(name);
    // A role with no session in a sample has none: per-role pg series count 0 there. Every other series must be in
    // every sample — a missing one is a failed probe, a vanished process or a restart (a new container name).
    const zeroFill = name.startsWith('pg:') && name !== 'pg:total';
    const pts = judged
      .filter((s) => zeroFill || name in s.values)
      .map((s) => [s.t, s.values[name] ?? 0] as [number, number]);
    const first = median(pts.filter(([t]) => t < start + windowMs).map(([, v]) => v));
    const last = median(pts.filter(([t]) => t > end - windowMs).map(([, v]) => v));
    const max = Math.max(...pts.map(([, v]) => v));
    const base = first > 0 ? first : 1;
    const growth = (last - first) / base;
    const horizon = spanMs >= o.trendMinMs ? 24 * 3_600_000 : spanMs;
    const projected24h = (slope(pts) * horizon) / base;
    const limit = limits[name] ?? null;
    let reason: string | null = null;
    let gap = 0;
    for (let i = 1; i < pts.length; i++)
      gap = Math.max(gap, (pts[i] as [number, number])[0] - (pts[i - 1] as [number, number])[0]);
    const monitored = kind !== 'other';
    if (monitored && !(pts[0] && pts[0][0] < start + windowMs)) {
      reason = 'no samples in the first window (appeared mid-run: a restart or a redeploy?)';
    } else if (monitored && !(pts.at(-1) && (pts.at(-1) as [number, number])[0] > end - windowMs)) {
      reason = 'no samples in the last window (the process or its probe went away)';
    } else if (monitored && gap > o.maxGapIntervals * interval) {
      reason = `a gap of ${Math.round(gap / 1000)} s in its samples (probe failed or restarted)`;
    } else if (kind === 'memory') {
      if (growth > o.memGrowth) reason = `grew ${(growth * 100).toFixed(1)} % (> ${o.memGrowth * 100} %)`;
      else if (projected24h > o.memGrowth)
        reason = `trend adds ${(projected24h * 100).toFixed(1)} % per 24 h (> ${o.memGrowth * 100} %)`;
    } else if (kind === 'connections') {
      if (limit !== null && max >= o.connCeiling * limit)
        reason = `peaked at ${max} of ${limit} (≥ ${o.connCeiling * 100} %)`;
      else if (last - first > Math.max(o.connGrowthMin, o.connGrowth * first))
        reason = `rose from ${first} to ${last} (> ${o.connGrowth * 100} %, ≥ ${o.connGrowthMin})`;
    }
    return { series: name, kind, first, last, max, growth, projected24h, limit, ok: reason === null, reason };
  });
  return {
    spanMs,
    samples: judged.length,
    acceptance: spanMs >= o.acceptanceMs && Number.isFinite(o.loadUntil),
    series,
    pass: series.every((s) => s.ok),
  };
}

const fmt = (kind: SeriesKind, v: number) =>
  kind === 'memory' ? `${(v / 1_048_576).toFixed(0)} MB` : Number.isInteger(v) ? String(v) : v.toFixed(1);

export function soakText(v: SoakVerdict): string {
  const hours = (v.spanMs / 3_600_000).toFixed(1);
  const lines = [
    `soak — ${hours} h judged after the warm-up, ${v.samples} samples${v.acceptance ? ' (the 24-hour acceptance soak)' : ' — a slice, NOT the 24-hour acceptance soak'}`,
    '  series                         first        last         max   growth     trend',
    ...v.series
      .filter((s) => s.kind !== 'other')
      .map(
        (s) =>
          `  ${s.series.padEnd(28)} ${fmt(s.kind, s.first).padStart(10)}  ${fmt(s.kind, s.last).padStart(10)}  ${fmt(s.kind, s.max).padStart(10)}` +
          `  ${(s.growth * 100).toFixed(1).padStart(6)} %  ${(s.projected24h * 100).toFixed(1).padStart(6)} %${s.ok ? '' : `  FAIL ${s.reason}`}`,
      ),
    v.pass ? '  PASS: no memory growth, no connection exhaustion' : '  FAIL: see the series above',
  ];
  return `${lines.join('\n')}\n`;
}

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  KIB: 1024,
  MB: 1e6,
  MIB: 1_048_576,
  GB: 1e9,
  GIB: 1_073_741_824,
};

/** `docker stats` MemUsage (`123.4MiB / 2GiB`) → bytes used. */
export function parseDockerMem(usage: string): number {
  const m = /^\s*([\d.]+)\s*([KMG]?i?B)\b/i.exec(usage);
  const unit = m ? UNITS[(m[2] as string).toUpperCase()] : undefined;
  if (!m || unit === undefined) throw new Error(`unreadable docker memory usage: ${usage}`);
  return Number(m[1]) * unit;
}

/** `/proc/<pid>/status` → VmRSS bytes. */
export function parseProcStatusRss(status: string): number {
  const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (!m) throw new Error('no VmRSS line');
  return Number(m[1]) * 1024;
}

/** `tasklist /FO CSV /NH` row (`"node.exe","1234","Console","1","123,456 K"`) → working set bytes. */
export function parseTasklistRss(row: string): number {
  const cols = [...row.matchAll(/"([^"]*)"/g)].map((x) => x[1] as string);
  const mem = cols[4];
  if (!mem) throw new Error(`unreadable tasklist row: ${row}`);
  return Number(mem.replace(/[^\d]/g, '')) * 1024;
}

/** Redis `INFO` text → its `key:value` fields. */
export function parseRedisInfo(info: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of info.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}
