/**
 * Pair scoring (R2-03a, PLAN §10): each signal 0–1 (null = not available for this pair), combined into one score.
 * Pure: no I/O. Tuned on the labelled fixture set (`__tests__/fixtures.ts`): precision ≥ 98 % at the auto-cluster
 * threshold `AUTO_CLUSTER_SCORE`.
 *
 * Signals:
 * - `images` — exact shared images: shared / the smaller set (overlap coefficient), over the images that are evidence;
 * - `phash` — near-identical photos (re-encoded, resized, lightly cropped): the share of the smaller set with a photo
 *   of the other within `PHASH_NEAR_BITS` bits (an exact one counts);
 * - `geo` — 1 within 50 m, 0.6 at 250 m, 0 from 1 km;
 * - `type` (same property type), `beds`, `baths` (equal 1, one apart 0.5), `area` (built m² within 5 % → 1, 0 from
 *   20 %), `price` (within ±5 % → 1, 0 from 20 %);
 * - `text` — description embedding cosine (0.80 → 0, 0.95 → 1), only when both listings have a vector of one model.
 *
 * Images that are not evidence: one in more than `WIDE_IMAGE_LISTINGS` listings (a development's renders, an agency's
 * banner) — found by the key-frequency counts of candidate generation; logos past the blocking cap are among them.
 *
 * Combination: the weighted mean of the available signals, `visual` = max(images, phash) / `VISUAL_FULL_SHARE`
 * (capped at 1) standing for both (an exact image is a near one too, a re-encoded photo is never an exact one). Then
 * caps that keep uncertain pairs out of auto-clustering (at most `REVIEW_CAP`, the review queue): no visual evidence
 * (share < `VISUAL_MIN_SHARE` or none), a hard
 * conflict (beds two apart, m² or price 20 % off), or both listings of one agency (a same-agency duplicate is flagged,
 * never merged automatically: developers list units with the same photos). A different property type scales the score
 * by 0.6; a different transaction (sale / rent) is never a duplicate (0).
 */
import type { DedupePairSignals } from '@inmolink/contracts';
import type { Signature } from './signature';

export const SCORER_VERSION = 1;
/** PLAN §10: ≥ 0.9 auto-cluster, 0.7–0.9 review (R2-03b). */
export const AUTO_CLUSTER_SCORE = 0.9;
export const REVIEW_SCORE = 0.7;
/** Pairs scoring less are not stored (nothing reads them: R2-03b reviews from 0.7; a re-score below deletes the pair). */
export const PAIR_STORE_MIN = REVIEW_SCORE;
/** The highest score a pair the caps hold back gets: inside the review band, never auto-clustered. */
export const REVIEW_CAP = 0.85;
export const PHASH_NEAR_BITS = 12;
/** The share of the smaller gallery (exact or near) that counts as full visual evidence. */
export const VISUAL_FULL_SHARE = 0.7;
/** Below this share a pair has no visual evidence of its own: at most `REVIEW_CAP` (shared building photos). */
export const VISUAL_MIN_SHARE = 0.4;
/** An image in more listings than this is not evidence that two of them are one property. */
export const WIDE_IMAGE_LISTINGS = 5;

/** Weights of the combined score (sum 1; renormalised over the signals a pair has). */
export const WEIGHTS = {
  visual: 0.45,
  geo: 0.15,
  type: 0.05,
  beds: 0.07,
  baths: 0.03,
  area: 0.1,
  price: 0.1,
  text: 0.05,
} as const;

/** Each signal 0–1; null: not available for the pair (the contract R2-03b serves). */
export type PairSignals = DedupePairSignals;

export interface PairScore {
  score: number;
  signals: PairSignals;
}

export type ScoredSignature = Pick<
  Signature,
  | 'listingId'
  | 'ownerAgencyId'
  | 'transactionType'
  | 'propertyTypeId'
  | 'beds'
  | 'baths'
  | 'areaM2'
  | 'priceCents'
  | 'lat'
  | 'lng'
  | 'imageKeys'
  | 'phashes'
>;

export interface PairContext {
  /** Image keys that are not evidence (in more than `WIDE_IMAGE_LISTINGS` listings). */
  wideImages?: ReadonlySet<bigint>;
  /** Description embedding cosine similarity, when both have a vector of one model. */
  cosine?: number | null;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function popcount32(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Bits that differ between two 64-bit hashes (same as `media.hammingDistance`, without a bigint loop). */
export function hamming(a: bigint, b: bigint): number {
  const x = BigInt.asUintN(64, a ^ b);
  return popcount32(Number(x & 0xffffffffn)) + popcount32(Number(x >> 32n));
}

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** < 50 m strong (1); 50–250 m → 1…0.6; 250 m–1 km → 0.6…0. */
export function geoSignal(d: number): number {
  if (d <= 50) return 1;
  if (d <= 250) return 1 - (0.4 * (d - 50)) / 200;
  return clamp01(0.6 - (0.6 * (d - 250)) / 750);
}

/** Relative difference within `full` → 1, linear to 0 at `zero`. */
function closeness(a: number, b: number, full: number, zero: number): number {
  const top = Math.max(Math.abs(a), Math.abs(b));
  if (top === 0) return 1;
  const rel = Math.abs(a - b) / top;
  if (rel <= full) return 1;
  return clamp01(1 - (rel - full) / (zero - full));
}

const countSignal = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a === b ? 1 : Math.abs(a - b) === 1 ? 0.5 : 0;

/**
 * A signature's images split once for scoring (cached per object): keys, and each pHash as two 32-bit halves so the
 * pair loop counts bits on numbers, never on bigints.
 */
interface Prepared {
  keys: readonly bigint[];
  lo: Uint32Array;
  hi: Uint32Array;
}
const prepared = new WeakMap<ScoredSignature, Prepared>();

function prepare(s: ScoredSignature): Prepared {
  let p = prepared.get(s);
  if (!p) {
    const lo = new Uint32Array(s.imageKeys.length);
    const hi = new Uint32Array(s.imageKeys.length);
    s.imageKeys.forEach((_, i) => {
      const u = BigInt.asUintN(64, s.phashes[i] ?? 0n);
      lo[i] = Number(u & 0xffffffffn);
      hi[i] = Number(u >> 32n);
    });
    p = { keys: s.imageKeys, lo, hi };
    prepared.set(s, p);
  }
  return p;
}

const hashedAt = (p: Prepared, i: number) => (p.lo[i] ?? 0) !== 0 || (p.hi[i] ?? 0) !== 0;
const bitsApart = (a: Prepared, i: number, b: Prepared, j: number) =>
  popcount32(((a.lo[i] ?? 0) ^ (b.lo[j] ?? 0)) >>> 0) + popcount32(((a.hi[i] ?? 0) ^ (b.hi[j] ?? 0)) >>> 0);

/** Indexes of the images of `p` that are evidence (not wide). */
const evidence = (p: Prepared, wide: ReadonlySet<bigint> | undefined) =>
  p.keys.flatMap((key, i) => (wide?.has(key) ? [] : [i]));

export function imageSignals(
  a: ScoredSignature,
  b: ScoredSignature,
  wide?: ReadonlySet<bigint>,
): { images: number | null; phash: number | null } {
  const pa = prepare(a);
  const pb = prepare(b);
  const ea = evidence(pa, wide);
  const eb = evidence(pb, wide);
  if (ea.length === 0 || eb.length === 0) return { images: null, phash: null };
  const [ps, small, pg, big] = ea.length <= eb.length ? [pa, ea, pb, eb] : [pb, eb, pa, ea];
  const bigKeys = new Set(big.map((j) => pg.keys[j]));
  const isExact = (i: number) => bigKeys.has(ps.keys[i]);
  const images = small.filter(isExact).length / small.length;
  const bigHashed = big.filter((j) => hashedAt(pg, j));
  const smallHashed = small.filter((i) => hashedAt(ps, i) || isExact(i));
  if (bigHashed.length === 0 || smallHashed.length === 0) return { images, phash: null };
  const near = smallHashed.filter(
    (i) => isExact(i) || bigHashed.some((j) => bitsApart(ps, i, pg, j) <= PHASH_NEAR_BITS),
  ).length;
  return { images, phash: near / smallHashed.length };
}

export function pairSignals(a: ScoredSignature, b: ScoredSignature, ctx: PairContext = {}): PairSignals {
  const { images, phash } = imageSignals(a, b, ctx.wideImages);
  const geo =
    a.lat !== null && a.lng !== null && b.lat !== null && b.lng !== null
      ? geoSignal(distanceM({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }))
      : null;
  const cos = ctx.cosine ?? null;
  return {
    images,
    phash,
    geo,
    type: a.propertyTypeId === b.propertyTypeId ? 1 : 0,
    beds: countSignal(a.beds, b.beds),
    baths: countSignal(a.baths, b.baths),
    area: a.areaM2 !== null && b.areaM2 !== null ? closeness(a.areaM2, b.areaM2, 0.05, 0.2) : null,
    price: a.priceCents !== null && b.priceCents !== null ? closeness(a.priceCents, b.priceCents, 0.05, 0.2) : null,
    text: cos === null ? null : clamp01((cos - 0.8) / 0.15),
  };
}

/** The combined score of a pair's signals (see the header for weights and caps). */
export function combine(s: PairSignals, sameAgency: boolean): number {
  const share = s.images === null && s.phash === null ? null : Math.max(s.images ?? 0, s.phash ?? 0);
  // a gallery mostly shared is full evidence: an agency often adds a few photos of its own
  const visual = share === null ? null : Math.min(1, share / VISUAL_FULL_SHARE);
  const parts: [number | null, number][] = [
    [visual, WEIGHTS.visual],
    [s.geo, WEIGHTS.geo],
    [s.type, WEIGHTS.type],
    [s.beds, WEIGHTS.beds],
    [s.baths, WEIGHTS.baths],
    [s.area, WEIGHTS.area],
    [s.price, WEIGHTS.price],
    [s.text, WEIGHTS.text],
  ];
  let sum = 0;
  let weight = 0;
  for (const [v, w] of parts) {
    if (v === null) continue;
    sum += v * w;
    weight += w;
  }
  let score = weight === 0 ? 0 : sum / weight;
  if (s.type === 0) score *= 0.6;
  const conflict = s.beds === 0 || s.area === 0 || s.price === 0;
  if (share === null || share < VISUAL_MIN_SHARE || conflict || sameAgency) score = Math.min(score, REVIEW_CAP);
  return round3(clamp01(score));
}

/** A candidate pair's score; null when the two can never be one property (sale vs rent). */
export function scorePair(a: ScoredSignature, b: ScoredSignature, ctx: PairContext = {}): PairScore | null {
  if (a.transactionType !== b.transactionType) return null;
  const raw = pairSignals(a, b, ctx);
  const signals = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v === null ? null : round3(v)]),
  ) as unknown as PairSignals;
  return { score: combine(raw, a.ownerAgencyId === b.ownerAgencyId), signals };
}
