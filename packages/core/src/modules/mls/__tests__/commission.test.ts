import { describe, expect, it } from 'vitest';
import { applyBp, commissionOf } from '../commission';

/**
 * R2-04a: the commission of a deal, from the terms snapshot — integer cents, half-up to the cent. Property tests over a
 * seeded generator (no new dependency): every case is reproducible from `SEED`, and the reference below is a second,
 * independent formulation (quotient and remainder, not `+ 5000`).
 */

const SEED = 0x5eed_2041;
const CASES = 20_000;

/** mulberry32: a small seeded PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const rnd = prng(SEED);
/** An integer in [lo, hi], with the edges and small values over-represented. */
function int(lo: number, hi: number): number {
  const pick = rnd();
  if (pick < 0.05) return lo;
  if (pick < 0.1) return hi;
  if (pick < 0.3) return lo + Math.floor(rnd() * Math.min(1_000, hi - lo + 1));
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

/** Exact rational x·bp/10,000 rounded half-up: the quotient, plus one when the remainder is at least half. */
function reference(x: bigint, bp: bigint): bigint {
  const n = x * bp;
  const q = n / 10_000n;
  const r = n % 10_000n;
  return r * 2n >= 10_000n ? q + 1n : q;
}

const MAX_PRICE = 10_000_000_000_000; // `deals_price_ck`

describe('[R2-04a] commission from the snapshot', () => {
  it('[R2-04a] total = price × commission_bp and the collaborator share = total × split_bp, exact to the cent (property)', () => {
    for (let i = 0; i < CASES; i += 1) {
      const price = int(1, MAX_PRICE);
      const bp = int(1, 10_000);
      const split = int(0, 10_000);
      const got = commissionOf(price, { commissionBp: bp, commissionFixedCents: null, splitBp: split });
      const total = reference(BigInt(price), BigInt(bp));
      const share = reference(total, BigInt(split));
      const at = `case ${i}: price ${price}, bp ${bp}, split ${split}`;
      expect(BigInt(got.totalCents), at).toBe(total);
      expect(BigInt(got.introducerShareCents), at).toBe(share);
      expect(BigInt(got.ownerShareCents), at).toBe(total - share);
      // the shares add up to the total exactly, never more, and none is negative
      expect(got.introducerShareCents + got.ownerShareCents, at).toBe(got.totalCents);
      expect(got.introducerShareCents, at).toBeGreaterThanOrEqual(0);
      expect(got.ownerShareCents, at).toBeGreaterThanOrEqual(0);
      // within half a cent of the exact amount (a tie rounds up)
      const exact = BigInt(price) * BigInt(bp);
      const err = total * 10_000n - exact;
      expect(err > -5_000n && err <= 5_000n, at).toBe(true);
    }
  });

  it('[R2-04a] a fixed commission is the total whatever the price; its split is exact to the cent (property)', () => {
    for (let i = 0; i < CASES; i += 1) {
      const price = int(1, MAX_PRICE);
      const fixed = int(1, 100_000_000_000);
      const split = int(0, 10_000);
      const got = commissionOf(price, { commissionBp: null, commissionFixedCents: fixed, splitBp: split });
      const share = reference(BigInt(fixed), BigInt(split));
      expect(got.totalCents).toBe(fixed);
      expect(BigInt(got.introducerShareCents)).toBe(share);
      expect(got.ownerShareCents).toBe(fixed - Number(share));
    }
  });

  it('[R2-04a] half a cent rounds up; the edges', () => {
    // 3 % of 1.50 € = 4.5 cents → 5
    expect(commissionOf(150, { commissionBp: 300, commissionFixedCents: null, splitBp: 5_000 })).toEqual({
      totalCents: 5,
      introducerShareCents: 3, // 2.5 → 3
      ownerShareCents: 2,
    });
    // 44.91 → 45, 44.88 → 45, 44.49 → 44
    expect(applyBp(1_497n, 300n)).toBe(45n);
    expect(applyBp(1_496n, 300n)).toBe(45n); // 44.88
    expect(applyBp(1_483n, 300n)).toBe(44n); // 44.49
    // 3 % of 600,000.00 €, split 60 / 40
    expect(commissionOf(60_000_000, { commissionBp: 300, commissionFixedCents: null, splitBp: 6_000 })).toEqual({
      totalCents: 1_800_000,
      introducerShareCents: 1_080_000,
      ownerShareCents: 720_000,
    });
    // split 0 % and 100 %; commission 100 %; the largest price
    expect(commissionOf(999, { commissionBp: 10_000, commissionFixedCents: null, splitBp: 0 })).toEqual({
      totalCents: 999,
      introducerShareCents: 0,
      ownerShareCents: 999,
    });
    expect(commissionOf(MAX_PRICE, { commissionBp: 10_000, commissionFixedCents: null, splitBp: 10_000 })).toEqual({
      totalCents: MAX_PRICE,
      introducerShareCents: MAX_PRICE,
      ownerShareCents: 0,
    });
    expect(() => commissionOf(0, { commissionBp: 300, commissionFixedCents: null, splitBp: 0 })).toThrow(RangeError);
    expect(() => applyBp(1n, 10_001n)).toThrow(RangeError);
  });
});
