import { describe, expect, it } from 'vitest';
import { hammingDistance } from '../../media';
import {
  combine,
  distanceM,
  geoSignal,
  hamming,
  imageSignals,
  type PairSignals,
  pairSignals,
  REVIEW_CAP,
  type ScoredSignature,
  scorePair,
} from '../scoring';
import { imageKeyOf, ownGeoKey, phashBandKeys, probeGeoKeys, probeKeysOf, signatureOf } from '../signature';

const SHA = (n: number) => n.toString(16).padStart(16, '0').padEnd(64, '0');
const T = '0190c000-0000-7000-8000-000000000001';

const sig = (over: Partial<ScoredSignature> = {}): ScoredSignature => ({
  listingId: '0190a000-0000-7000-8000-000000000001',
  ownerAgencyId: '0190b000-0000-7000-8000-000000000001',
  transactionType: 'SALE',
  propertyTypeId: T,
  beds: 3,
  baths: 2,
  areaM2: 120,
  priceCents: 50_000_000,
  lat: 36.5,
  lng: -4.9,
  imageKeys: [],
  phashes: [],
  ...over,
});

const other = (over: Partial<ScoredSignature> = {}) =>
  sig({
    listingId: '0190a000-0000-7000-8000-000000000002',
    ownerAgencyId: '0190b000-0000-7000-8000-000000000002',
    ...over,
  });

describe('dedupe signals (R2-03a)', () => {
  it('[R2-03a] exact shared images: overlap of the smaller gallery; wide images are not evidence', () => {
    const k = [1, 2, 3, 4].map((n) => imageKeyOf(SHA(n)));
    const a = sig({ imageKeys: k, phashes: [0n, 0n, 0n, 0n] });
    const b = other({ imageKeys: [k[0], k[1], imageKeyOf(SHA(9))] as bigint[], phashes: [0n, 0n, 0n] });
    expect(imageSignals(a, b).images).toBeCloseTo(2 / 3);
    expect(imageSignals(a, b, new Set([k[0] as bigint])).images).toBeCloseTo(1 / 2);
    expect(imageSignals(a, other()).images).toBeNull();
  });

  it('[R2-03a] pHash: near photos within the bit budget count, far ones do not; the popcount matches media', () => {
    const p = 0x0f0f_1234_abcd_5678n;
    expect(hamming(p, p ^ 0b1011n)).toBe(3);
    expect(hamming(p, ~p)).toBe(64);
    expect(hamming(p, p ^ 0xffffn)).toBe(hammingDistance(p, p ^ 0xffffn));
    const a = sig({ imageKeys: [1n, 2n], phashes: [p, p ^ 0xffff_ffffn] });
    const near = other({ imageKeys: [3n, 4n], phashes: [p ^ 0b111n, 0x7777_0000_0000_0000n] });
    expect(imageSignals(a, near).phash).toBeCloseTo(1 / 2);
    expect(imageSignals(a, near).images).toBe(0);
  });

  it('[R2-03a] geo: < 50 m strong, fading to 0 at 1 km; none without both pins', () => {
    expect(geoSignal(30)).toBe(1);
    expect(geoSignal(250)).toBeCloseTo(0.6);
    expect(geoSignal(1_000)).toBe(0);
    expect(distanceM({ lat: 36.5, lng: -4.9 }, { lat: 36.5009, lng: -4.9 })).toBeCloseTo(100, -1);
    expect(pairSignals(sig(), other({ lat: null, lng: null })).geo).toBeNull();
  });

  it('[R2-03a] type, beds, baths, built m² within tolerance; price within ±5 %', () => {
    const s = (o: Partial<ScoredSignature>) => pairSignals(sig(), other(o));
    expect(s({ propertyTypeId: '0190c000-0000-7000-8000-000000000009' }).type).toBe(0);
    expect(s({ beds: 4 }).beds).toBe(0.5);
    expect(s({ beds: 5 }).beds).toBe(0);
    expect(s({ baths: null }).baths).toBeNull();
    expect(s({ areaM2: 125 }).area).toBe(1);
    expect(s({ areaM2: 150 }).area).toBe(0);
    expect(s({ priceCents: 52_000_000 }).price).toBe(1);
    expect(s({ priceCents: 55_000_000 }).price).toBeCloseTo(0.727, 2);
    expect(s({ priceCents: null }).price).toBeNull();
  });

  it('[R2-03a] description embedding cosine only when present', () => {
    expect(pairSignals(sig(), other()).text).toBeNull();
    expect(pairSignals(sig(), other(), { cosine: 0.95 }).text).toBeCloseTo(1);
    expect(pairSignals(sig(), other(), { cosine: 0.5 }).text).toBe(0);
  });

  it('[R2-03a] combination: weighted mean, caps without visual evidence, on conflicts and within one agency', () => {
    const full: PairSignals = {
      images: 1,
      phash: 1,
      geo: 1,
      type: 1,
      beds: 1,
      baths: 1,
      area: 1,
      price: 1,
      text: null,
    };
    expect(combine(full, false)).toBe(1);
    expect(combine(full, true)).toBe(REVIEW_CAP);
    expect(combine({ ...full, images: 0.2, phash: 0.2 }, false)).toBeLessThanOrEqual(REVIEW_CAP);
    expect(combine({ ...full, images: null, phash: null }, false)).toBeLessThanOrEqual(REVIEW_CAP);
    expect(combine({ ...full, price: 0 }, false)).toBeLessThanOrEqual(REVIEW_CAP);
    expect(combine({ ...full, type: 0 }, false)).toBeCloseTo(0.6 * (0.95 / 1), 1);
    expect(scorePair(sig(), other({ transactionType: 'RENT' }))).toBeNull();
  });
});

describe('dedupe blocking keys (R2-03a)', () => {
  const facts = { transactionType: 'SALE', propertyTypeId: T };

  it('[R2-03a] a pin a cell away, or one bed apart in the same cell, is in the probe; the own key is stored', () => {
    const here = { lat: 36.5, lng: -4.9 };
    const probe = new Set(probeGeoKeys(here, facts, 3));
    expect(probe.size).toBe(11);
    expect(probe.has(ownGeoKey(here, facts, 3))).toBe(true);
    expect(probe.has(ownGeoKey(here, facts, 4))).toBe(true);
    expect(probe.has(ownGeoKey({ lat: 36.5012, lng: -4.9015 }, facts, 3))).toBe(true);
    expect(probe.has(ownGeoKey({ lat: 36.51, lng: -4.9 }, facts, 3))).toBe(false);
    expect(probe.has(ownGeoKey(here, { ...facts, transactionType: 'RENT' }, 3))).toBe(false);
  });

  it('[R2-03a] pHash bands: photos within 3 bits always share a band (per city)', () => {
    const p = 0x1234_5678_9abc_def0n;
    for (const flip of [0b1n, 0b1n | (1n << 20n), (1n << 5n) | (1n << 37n) | (1n << 60n)]) {
      const a = new Set(phashBandKeys(p, 'c'));
      expect(phashBandKeys(p ^ flip, 'c').some((k) => a.has(k))).toBe(true);
    }
    expect(phashBandKeys(p, 'c').some((k) => new Set(phashBandKeys(p, 'd')).has(k))).toBe(false);
  });

  it('[R2-03a] a signature keeps its first images and keys them; probe keys cover stored keys', () => {
    const images = Array.from({ length: 15 }, (_, i) => ({ sha256: SHA(i + 1), phash: BigInt(i + 1) << 8n }));
    const s = signatureOf({
      listingId: '0190a000-0000-7000-8000-000000000001',
      ownerAgencyId: '0190b000-0000-7000-8000-000000000001',
      version: 3,
      transactionType: 'SALE',
      propertyTypeId: T,
      locationIds: ['c', 'r', 'city', 'area'],
      beds: 2,
      baths: 1,
      areaM2: 80,
      priceCents: null,
      geo: { lat: 36.5, lng: -4.9 },
      images,
    });
    expect(s.imageKeys).toHaveLength(12);
    expect(s.cityId).toBe('city');
    const probe = new Set(probeKeysOf(s));
    for (const k of s.blockKeys) expect(probe.has(k)).toBe(true);
  });
});
