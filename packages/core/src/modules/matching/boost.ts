/**
 * The match engine's learned boost (R2-02c, PLAN §7 M9), pure: what a client liked and turned down moves the score of
 * similar listings a little. A profile's feedback (`client_profile_feedback`: likes from the selections of its
 * contact, dislikes from dismissed matches) is summed per affinity key in `client_profile_affinities` — the listing's
 * property type, its places, its features and its price band, each a 32-bit hash with its dimension in the low 2 bits
 * (`affinityKey`). For a candidate listing, per dimension, over the listing's keys the summary knows:
 *
 *   s = Σ (likes − dislikes) / Σ (likes + dislikes + `AFFINITY_PRIOR`)        (Laplace-style: one like gives 1/3)
 *
 * so s ∈ (−1, 1) and 0 with no feedback; the boost is `MAX_BOOST` × the weighted mean of the four dimensions, so it
 * stays within ±`MAX_BOOST`. Keys are hashes of taxonomy ids and band numbers only — never client data. A hash
 * collision (two keys of one profile, about 1 in 100,000 at the cap) only blends their counts: the boost stays bounded.
 */

/** The boost never moves a total by more than this (either way). */
export const MAX_BOOST = 0.15;
/** Pseudo-counts per key (Laplace-style smoothing): one like scores 1/3 of the way, ten 10/12. */
export const AFFINITY_PRIOR = 2;
/** Price bands are this wide (a ratio: each band's prices are 1.5 × the previous band's). */
export const PRICE_BAND_RATIO = 1.5;
/**
 * A summary keeps at most this many keys (those with the most feedback): ≈ 1.5 KB a row, read inline (no TOAST) by
 * the engine. A key dropped at the cap loses its counts; a later reversal of a signal that carried it cannot take them
 * back (clamped at 0) — an accepted approximation: only profiles with very wide feedback reach the cap.
 */
export const MAX_AFFINITY_KEYS = 128;

export type AffinityDimension = 'propertyType' | 'location' | 'features' | 'price';
/** The explanation's dimension order; a key's low 2 bits are its index here. */
export const AFFINITY_DIMENSIONS: readonly AffinityDimension[] = ['propertyType', 'location', 'features', 'price'];
/** Each dimension's weight in the boost (they add up to 1). */
export const AFFINITY_WEIGHTS: Readonly<Record<AffinityDimension, number>> = {
  propertyType: 0.3,
  location: 0.3,
  features: 0.2,
  price: 0.2,
};

export interface AffinityListing {
  transactionType: string;
  propertyTypeId: string;
  locationIds: readonly string[];
  featureIds: readonly string[];
  /** Null: price on request (no band). */
  priceCents: number | null;
}

/** A key's hash (FNV-1a, 32 bits, signed: a Postgres `integer`) with the dimension in its low 2 bits. */
export function affinityKey(dimension: AffinityDimension, value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h & ~3) | AFFINITY_DIMENSIONS.indexOf(dimension);
}

/** A key's dimension. */
export const dimensionOf = (key: number): AffinityDimension => AFFINITY_DIMENSIONS[key & 3] as AffinityDimension;

/** The price band of a price (whole euros on a 1.5× scale; rent and sale apart). */
export const priceBand = (transactionType: string, priceCents: number): string =>
  `${transactionType}:${Math.floor(Math.log(Math.max(1, priceCents / 100)) / Math.log(PRICE_BAND_RATIO))}`;

/** A listing's affinity keys (sorted ascending, distinct). */
export function affinityKeys(l: AffinityListing): number[] {
  const keys = new Set<number>([affinityKey('propertyType', l.propertyTypeId)]);
  for (const id of l.locationIds) keys.add(affinityKey('location', id));
  for (const id of l.featureIds) keys.add(affinityKey('features', id));
  if (l.priceCents !== null && l.priceCents > 0) {
    keys.add(affinityKey('price', priceBand(l.transactionType, l.priceCents)));
  }
  return [...keys].sort((a, b) => a - b);
}

/** A profile's summary: parallel arrays sorted by key (as stored). */
export interface AffinitySummary {
  keys: readonly number[];
  likes: readonly number[];
  dislikes: readonly number[];
}

export const EMPTY_SUMMARY: AffinitySummary = { keys: [], likes: [], dislikes: [] };

/** Index of `key` in the sorted `keys`, or −1. */
function find(keys: readonly number[], key: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = keys[mid] as number;
    if (k === key) return mid;
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Stored in the explanation when the boost is not 0: its value and the dimensions that moved it up or down. */
export interface BoostReason {
  value: number;
  liked: AffinityDimension[];
  disliked: AffinityDimension[];
}

export interface Boost {
  /** Within ±`MAX_BOOST`, rounded to 3 decimals; 0 with no feedback. */
  value: number;
  /** Null when the value is 0. */
  reason: BoostReason | null;
}

const ZERO: Boost = { value: 0, reason: null };

/** The boost of a listing for a profile with this summary (none or empty: 0). */
export function boostOf(summary: AffinitySummary | undefined, l: AffinityListing): Boost {
  if (!summary || summary.keys.length === 0) return ZERO;
  const net = [0, 0, 0, 0];
  const mass = [0, 0, 0, 0];
  for (const key of affinityKeys(l)) {
    const i = find(summary.keys, key);
    if (i < 0) continue;
    const likes = Math.max(0, summary.likes[i] ?? 0);
    const dislikes = Math.max(0, summary.dislikes[i] ?? 0);
    const d = key & 3;
    net[d] = (net[d] ?? 0) + likes - dislikes;
    mass[d] = (mass[d] ?? 0) + likes + dislikes + AFFINITY_PRIOR;
  }
  const liked: AffinityDimension[] = [];
  const disliked: AffinityDimension[] = [];
  let raw = 0;
  AFFINITY_DIMENSIONS.forEach((dim, d) => {
    const m = mass[d] ?? 0;
    if (m === 0) return;
    const s = (net[d] ?? 0) / m;
    raw += AFFINITY_WEIGHTS[dim] * s;
    if (s > 0) liked.push(dim);
    else if (s < 0) disliked.push(dim);
  });
  const value = Math.round(Math.min(MAX_BOOST, Math.max(-MAX_BOOST, MAX_BOOST * raw)) * 1000) / 1000;
  return value === 0 ? ZERO : { value, reason: { value, liked, disliked } };
}

export type FeedbackSignal = 'LIKE' | 'DISLIKE';

/**
 * The summary deltas of one profile's signal on one listing moving from `before` to `after` (either null: none):
 * what the old signal added is taken back, what the new one adds is added. Keys with no change are left out.
 */
export function affinityDeltas(
  before: { signal: FeedbackSignal; keys: readonly number[] } | null,
  after: { signal: FeedbackSignal; keys: readonly number[] } | null,
): { key: number; likes: number; dislikes: number }[] {
  const d = new Map<number, [number, number]>();
  const add = (s: { signal: FeedbackSignal; keys: readonly number[] } | null, sign: 1 | -1) => {
    for (const key of new Set(s?.keys ?? [])) {
      const v = d.get(key) ?? [0, 0];
      v[s?.signal === 'LIKE' ? 0 : 1] += sign;
      d.set(key, v);
    }
  };
  add(before, -1);
  add(after, 1);
  return [...d]
    .filter(([, [l, x]]) => l !== 0 || x !== 0)
    .sort(([a], [b]) => a - b)
    .map(([key, [likes, dislikes]]) => ({ key, likes, dislikes }));
}

/**
 * A stored summary with these deltas applied (pure): counts never below 0, keys left at 0 / 0 dropped, at most
 * `MAX_AFFINITY_KEYS` kept (the most feedback first, then key order); answers sorted parallel arrays.
 */
export function withDeltas(
  summary: AffinitySummary,
  deltas: readonly { key: number; likes: number; dislikes: number }[],
): AffinitySummary {
  const next = new Map<number, [number, number]>();
  summary.keys.forEach((k, i) => {
    next.set(k, [Math.max(0, summary.likes[i] ?? 0), Math.max(0, summary.dislikes[i] ?? 0)]);
  });
  for (const d of deltas) {
    const v = next.get(d.key) ?? [0, 0];
    next.set(d.key, [Math.max(0, v[0] + d.likes), Math.max(0, v[1] + d.dislikes)]);
  }
  const kept = [...next]
    .filter(([, [l, x]]) => l > 0 || x > 0)
    .sort(([ka, [la, da]], [kb, [lb, db]]) => lb + db - (la + da) || ka - kb)
    .slice(0, MAX_AFFINITY_KEYS)
    .sort(([a], [b]) => a - b);
  return {
    keys: kept.map(([k]) => k),
    likes: kept.map(([, [l]]) => l),
    dislikes: kept.map(([, [, x]]) => x),
  };
}
