import { describe, expect, it } from 'vitest';
import {
  type AffinityListing,
  type AffinitySummary,
  affinityDeltas,
  affinityKey,
  affinityKeys,
  boostOf,
  dimensionOf,
  EMPTY_SUMMARY,
  explainMatch,
  explanationText,
  MAX_AFFINITY_KEYS,
  MAX_BOOST,
  type MatchExplanation,
  scoreMatch,
  withDeltas,
} from '../index';

/** The learned boost (R2-02c), pure: keys, deltas, bounds, smoothing, the stored summary and the explanation. */

const villa: AffinityListing = {
  transactionType: 'SALE',
  propertyTypeId: 'type-villa',
  locationIds: ['es', 'andalucia', 'marbella', 'golden-mile'],
  featureIds: ['pool', 'garden'],
  priceCents: 120_000_000,
};
const flat: AffinityListing = {
  transactionType: 'SALE',
  propertyTypeId: 'type-flat',
  locationIds: ['fr', 'idf', 'paris'],
  featureIds: ['lift'],
  priceCents: 30_000_000,
};
const similarVilla: AffinityListing = {
  ...villa,
  locationIds: ['es', 'andalucia', 'marbella'],
  priceCents: 125_000_000,
};

/** A summary built the way the feedback worker builds it: one delta per signal. */
function summaryOf(signals: { signal: 'LIKE' | 'DISLIKE'; listing: AffinityListing }[]): AffinitySummary {
  let s = EMPTY_SUMMARY;
  for (const x of signals) s = withDeltas(s, affinityDeltas(null, { signal: x.signal, keys: affinityKeys(x.listing) }));
  return s;
}

/** Every key of the listing at these counts. */
const at = (l: AffinityListing, counts: (i: number) => [number, number]): AffinitySummary => {
  const keys = affinityKeys(l);
  return { keys, likes: keys.map((_, i) => counts(i)[0]), dislikes: keys.map((_, i) => counts(i)[1]) };
};

const noCriteria = {
  transactionType: 'SALE',
  propertyTypeIds: [],
  locationIds: [],
  featureIds: [],
  priceMinCents: null,
  priceMaxCents: null,
  bedsMin: null,
  bathsMin: null,
  areaMinM2: null,
  areaMaxM2: null,
};

describe('learned boost (R2-02c)', () => {
  it('[R2-02c] no feedback gives boost 0 and no reason', () => {
    expect(boostOf(undefined, villa)).toEqual({ value: 0, reason: null });
    expect(boostOf(EMPTY_SUMMARY, villa)).toEqual({ value: 0, reason: null });
    // feedback on unrelated listings only: still 0
    expect(boostOf(summaryOf([{ signal: 'LIKE', listing: flat }]), villa)).toEqual({ value: 0, reason: null });
    const e = explainMatch(noCriteria, { ...villa, beds: 3, baths: 2, areaM2: 200 });
    expect(scoreMatch(e, null).boost).toBe(0);
  });

  it('[R2-02c] likes raise similar listings, smoothed (one like does not dominate), more likes raise more', () => {
    const one = boostOf(summaryOf([{ signal: 'LIKE', listing: villa }]), similarVilla);
    expect(one.value).toBeGreaterThan(0);
    // Laplace-style: one like is a third of the way to the cap
    expect(one.value).toBeLessThanOrEqual(MAX_BOOST / 3 + 1e-9);
    expect(one.reason).toEqual({
      value: one.value,
      liked: ['propertyType', 'location', 'features', 'price'],
      disliked: [],
    });
    const ten = boostOf(
      summaryOf(Array.from({ length: 10 }, () => ({ signal: 'LIKE' as const, listing: villa }))),
      similarVilla,
    );
    expect(ten.value).toBeGreaterThan(one.value);
    // a dissimilar listing is not raised by the same likes
    expect(boostOf(summaryOf([{ signal: 'LIKE', listing: villa }]), flat).value).toBe(0);
  });

  it('[R2-02c] dislikes and dismissals lower similar listings; mixed feedback nets out', () => {
    const down = boostOf(summaryOf([{ signal: 'DISLIKE', listing: villa }]), similarVilla);
    expect(down.value).toBeLessThan(0);
    expect(down.reason?.disliked).toEqual(['propertyType', 'location', 'features', 'price']);
    expect(down.reason?.liked).toEqual([]);
    const even = summaryOf([
      { signal: 'LIKE', listing: villa },
      { signal: 'DISLIKE', listing: villa },
    ]);
    expect(boostOf(even, similarVilla).value).toBe(0);
    // liked villas, turned-down flats: a villa up, a flat down
    const mixed = summaryOf([
      { signal: 'LIKE', listing: villa },
      { signal: 'DISLIKE', listing: flat },
    ]);
    expect(boostOf(mixed, similarVilla).value).toBeGreaterThan(0);
    expect(boostOf(mixed, flat).value).toBeLessThan(0);
  });

  it('[R2-02c] the boost stays inside ±MAX_BOOST and the total inside 0–1', () => {
    const up = boostOf(
      at(villa, () => [1_000_000, 0]),
      villa,
    ).value;
    const down = boostOf(
      at(villa, () => [0, 1_000_000]),
      villa,
    ).value;
    expect(up).toBeLessThanOrEqual(MAX_BOOST);
    expect(up).toBeGreaterThan(0.14);
    expect(down).toBeGreaterThanOrEqual(-MAX_BOOST);
    expect(down).toBeLessThan(-0.14);
    // random summaries never leave the bounds (negative counts from a broken row are read as 0)
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 500; i++) {
      const b = boostOf(
        at(villa, () => [Math.floor(rnd() * 50) - 5, Math.floor(rnd() * 50) - 5]),
        villa,
      ).value;
      expect(Math.abs(b)).toBeLessThanOrEqual(MAX_BOOST);
    }
    const perfect: MatchExplanation = {
      v: 1,
      criteria: [],
      satisfied: [],
      unsatisfied: [],
      priceDeltaPct: null,
      priceOnRequest: false,
      mustHaves: null,
    };
    expect(scoreMatch(perfect, 1, MAX_BOOST).total).toBe(1);
    expect(scoreMatch({ ...perfect, criteria: [{ key: 'price', ok: false, score: 0 }] }, 0, -MAX_BOOST).total).toBe(0);
  });

  it('[R2-02c] keys carry their dimension; a signal change takes back exactly what it added; the summary is capped', () => {
    const keys = affinityKeys(villa);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    expect(keys).toEqual(
      expect.arrayContaining([
        affinityKey('propertyType', 'type-villa'),
        affinityKey('location', 'marbella'),
        affinityKey('features', 'pool'),
      ]),
    );
    expect(keys.map(dimensionOf).filter((d) => d === 'location')).toHaveLength(4);
    expect(keys.map(dimensionOf).filter((d) => d === 'price')).toHaveLength(1);
    expect(affinityKeys({ ...villa, priceCents: null }).map(dimensionOf)).not.toContain('price');
    for (const k of keys) expect(k).toBe(k | 0); // a Postgres integer

    expect(affinityDeltas({ signal: 'LIKE', keys }, { signal: 'LIKE', keys })).toEqual([]);
    const flip = affinityDeltas({ signal: 'DISLIKE', keys }, { signal: 'LIKE', keys });
    expect(flip).toHaveLength(keys.length);
    for (const d of flip) expect(d).toMatchObject({ likes: 1, dislikes: -1 });
    const liked = withDeltas(EMPTY_SUMMARY, affinityDeltas(null, { signal: 'LIKE', keys }));
    expect(liked.keys).toEqual(keys);
    expect(liked.likes.every((l) => l === 1) && liked.dislikes.every((d) => d === 0)).toBe(true);
    expect(withDeltas(liked, affinityDeltas({ signal: 'LIKE', keys }, null))).toEqual(EMPTY_SUMMARY);
    expect(withDeltas(EMPTY_SUMMARY, [{ key: 4, likes: -1, dislikes: 0 }])).toEqual(EMPTY_SUMMARY);
    // at most MAX_AFFINITY_KEYS keys, those with the most feedback, sorted by key
    const big: AffinitySummary = {
      keys: Array.from({ length: MAX_AFFINITY_KEYS + 10 }, (_, i) => i * 4),
      likes: Array.from({ length: MAX_AFFINITY_KEYS + 10 }, (_, i) => i + 1),
      dislikes: Array.from({ length: MAX_AFFINITY_KEYS + 10 }, () => 0),
    };
    const capped = withDeltas(big, []);
    expect(capped.keys).toHaveLength(MAX_AFFINITY_KEYS);
    expect(capped.keys).not.toContain(0);
    expect(capped.keys).toEqual([...capped.keys].sort((a, b) => a - b));
  });

  it('[R2-02c] the explanation includes the boost reason (EN + ES, from i18n keys)', () => {
    const base = explainMatch(
      { ...noCriteria, propertyTypeIds: ['type-villa'] },
      { ...villa, beds: 3, baths: 2, areaM2: 200 },
    );
    const e: MatchExplanation = {
      ...base,
      boost: { value: 0.05, liked: ['propertyType', 'location'], disliked: ['price'] },
    };
    expect(explanationText(e, 'en').lines).toEqual(
      expect.arrayContaining([
        'Similar to listings the client liked (type, area)',
        'Similar to listings the client turned down (price range)',
      ]),
    );
    expect(explanationText(e, 'es').lines).toEqual(
      expect.arrayContaining(['Parecido a inmuebles que le gustaron al cliente (tipo, zona)']),
    );
    // no boost: no reason line
    expect(explanationText(base, 'en').lines.some((l) => l.startsWith('Similar to'))).toBe(false);
  });
});
