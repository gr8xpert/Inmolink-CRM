import { describe, expect, it } from 'vitest';
import { AUTO_CLUSTER_SCORE, scorePair, WIDE_IMAGE_LISTINGS } from '../scoring';
import { type Signature, signatureOf } from '../signature';
import { buildFixtureSet, type FixtureSet } from './fixtures';

/**
 * R2-03 Done-when: precision ≥ 98 % on the labelled fixture set at the auto-cluster threshold (0.9). Scores each
 * labelled pair as the worker does — image keys held by more than `WIDE_IMAGE_LISTINGS` listings of the set are not
 * evidence — and records recall (logged; asserted as a floor so a weight change that loses it shows).
 */

let seq = 0;
const fakeId = () => `0190a000-0000-7000-8000-${(seq++).toString(16).padStart(12, '0')}`;
const AGENCIES = [0, 1, 2, 3, 4, 5].map((i) => `0190b000-0000-7000-8000-00000000000${i}`);

let set: FixtureSet;
let sigs: Map<string, Signature>;
let frequency: Map<bigint, number>;

async function load() {
  set ??= await buildFixtureSet({
    newId: fakeId,
    agencies: AGENCIES,
    types: ['0190c000-0000-7000-8000-000000000001', '0190c000-0000-7000-8000-000000000002'],
    locationIds: [
      '0190d000-0000-7000-8000-000000000001',
      '0190d000-0000-7000-8000-000000000002',
      '0190d000-0000-7000-8000-000000000003',
    ],
  });
  sigs = new Map(set.listings.map((l) => [l.listingId, signatureOf(l)]));
  frequency = new Map();
  for (const s of sigs.values()) for (const k of new Set(s.imageKeys)) frequency.set(k, (frequency.get(k) ?? 0) + 1);
}

function score(a: string, b: string): number {
  const sa = sigs.get(a) as Signature;
  const sb = sigs.get(b) as Signature;
  const wide = new Set([...sa.imageKeys, ...sb.imageKeys].filter((k) => (frequency.get(k) ?? 0) > WIDE_IMAGE_LISTINGS));
  return scorePair(sa, sb, { wideImages: wide })?.score ?? 0;
}

describe('dedupe labelled fixture set (R2-03a)', () => {
  it('[R2-03] precision ≥ 98% on the labelled fixture set', async () => {
    await load();
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const byKind = new Map<string, number[]>();
    for (const p of set.pairs) {
      const s = score(p.a, p.b);
      byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), s]);
      const auto = s >= AUTO_CLUSTER_SCORE;
      if (auto && p.duplicate) tp++;
      else if (auto) fp++;
      else if (p.duplicate) fn++;
    }
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    const summary = [...byKind].map(
      ([k, v]) => `${k}: n=${v.length} min=${Math.min(...v).toFixed(3)} max=${Math.max(...v).toFixed(3)}`,
    );
    console.info(
      `[R2-03a] fixture set: ${set.pairs.length} pairs, precision ${(precision * 100).toFixed(1)} %, recall ${(recall * 100).toFixed(1)} %\n  ${summary.join('\n  ')}`,
    );
    expect(tp + fn).toBe(36);
    expect(precision).toBeGreaterThanOrEqual(0.98);
    // recorded in STATUS; a floor so a weight change that loses most duplicates fails
    expect(recall).toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  it('[R2-03a] hard negatives with evidence stay in or below the review band, never auto-clustered', async () => {
    await load();
    for (const p of set.pairs.filter((x) => !x.duplicate)) {
      expect(score(p.a, p.b), `${p.kind} ${p.a}/${p.b}`).toBeLessThan(AUTO_CLUSTER_SCORE);
    }
  }, 120_000);
});
