import { createHash } from 'node:crypto';

/**
 * Deterministic randomness for seeds: the same `--seed` produces the same rows on every machine,
 * so a re-run finds its own rows by ID (idempotency) and perf numbers compare across runs.
 */

/** Fixed creation time of seeded IDs: UUIDv7 timestamps stay plausible and identical across runs. */
const BASE_MS = Date.UTC(2026, 0, 1);

/**
 * UUIDv7-shaped ID derived from `(seed, namespace, index)`. The timestamp is `BASE_MS + index`, so IDs
 * of one namespace sort by index like app-generated ones; the random bits come from SHA-256.
 */
export function seededId(seed: number, namespace: string, index: number): string {
  const b = createHash('sha256').update(`${seed}:${namespace}:${index}`).digest().subarray(0, 16);
  b.writeUIntBE(BASE_MS + index, 0, 6);
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32: tiny, fast and good enough for synthetic data. Fork one per (seed, namespace, chunk). */
export function createRng(seed: number, namespace = ''): Rng {
  let a = createHash('sha256').update(`${seed}:${namespace}`).digest().readUInt32BE(0);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      if (items.length === 0) throw new RangeError('pick: empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
  };
}
