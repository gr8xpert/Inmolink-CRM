import { describe, expect, it } from 'vitest';
import { histogramPercentile, WAIT_HISTOGRAM_MAX_ROWS, waitBucket } from '../repo';

/** `percentile_cont` over a list, as Postgres computes it (linear between the two nearest ranks). */
function percentileCont(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = (sorted.length - 1) * q;
  const lo = sorted[Math.floor(rank)] as number;
  const hi = sorted[Math.ceil(rank)] as number;
  return lo + (hi - lo) * (rank - Math.floor(rank));
}

describe('staff import health waits (S7-F10)', () => {
  it('[S7-F10] the p95 queue wait from the per-second histogram equals percentile_cont over the runs', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (const n of [1, 2, 19, 20, 21, 1_000, 12_345]) {
      const waits = Array.from({ length: n }, () => Math.round(next() < 0.9 ? next() * 120 : next() * 3_600));
      const histogram = new Map<number, number>();
      for (const w of waits) histogram.set(w, (histogram.get(w) ?? 0) + 1);
      const rows = [...histogram].map(([value, count]) => ({ value, count }));
      for (const q of [0, 0.5, 0.95, 1]) {
        expect(histogramPercentile(rows, q), `n=${n} q=${q}`).toBeCloseTo(percentileCont(waits, q), 9);
      }
    }
    expect(histogramPercentile([], 0.95)).toBe(0);
    expect(histogramPercentile([{ value: 5, count: 0 }], 0.95)).toBe(0);
  });
});

describe('staff import health wait buckets (S7-F10 perf review)', () => {
  it('[S7-F10] wait buckets: by the second to 10 min, 10 s to 1 h, the minute to a day, the hour to a week — bounded', () => {
    expect([0, 1, 599, 600, 609, 3_599, 3_600, 3_659, 86_399, 86_400, 90_000, 10_000_000].map(waitBucket)).toEqual([
      0, 1, 599, 600, 600, 3_590, 3_600, 3_600, 86_340, 86_400, 90_000, 604_800,
    ]);
    const buckets = new Set<number>();
    for (let w = 0; w <= 700_000; w++) buckets.add(waitBucket(w));
    expect(buckets.size).toBe(WAIT_HISTOGRAM_MAX_ROWS);
  });
});
