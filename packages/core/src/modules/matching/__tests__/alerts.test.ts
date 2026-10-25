import { describe, expect, it } from 'vitest';
import { listingKeys, NEW_LISTING_WINDOW_MS, searchKeys, transitionOf } from '../alerts';

const NOW = Date.UTC(2026, 9, 25, 12);
const recent = Math.floor((NOW - 3_600_000) / 1000);
const old = Math.floor((NOW - NEW_LISTING_WINDOW_MS - 3_600_000) / 1000);
const active = (over: Partial<{ priceCents: number | null; version: number; publishedAt: number }> = {}) => ({
  status: 'ACTIVE',
  priceCents: 500_000_00,
  version: 3,
  publishedAt: recent,
  ...over,
});

describe('saved search alert rules', () => {
  it('[S5-06] a listing never seen is NEW only within its first week; an old one is recorded silently', () => {
    expect(transitionOf(undefined, active(), NOW)).toEqual({ kind: 'NEW', dedupeKey: 0, previousPriceCents: null });
    expect(transitionOf(undefined, active({ publishedAt: old }), NOW)).toBeNull();
  });

  it('[S5-06] price drop, back on market, and nothing for other changes or non-active listings', () => {
    const seen = { status: 'ACTIVE', priceCents: 500_000_00, version: 2 };
    expect(transitionOf(seen, active({ priceCents: 450_000_00 }), NOW)).toEqual({
      kind: 'PRICE_DROP',
      dedupeKey: 3,
      previousPriceCents: 500_000_00,
    });
    expect(transitionOf(seen, active({ priceCents: 550_000_00 }), NOW)).toBeNull();
    expect(transitionOf(seen, active(), NOW)).toBeNull();
    expect(transitionOf(seen, active({ priceCents: null }), NOW)).toBeNull();
    for (const status of ['UNDER_OFFER', 'SOLD', 'GONE']) {
      expect(transitionOf({ ...seen, status }, active(), NOW)).toEqual({
        kind: 'BACK_ON_MARKET',
        dedupeKey: 3,
        previousPriceCents: null,
      });
    }
    expect(transitionOf(seen, { ...active(), status: 'UNDER_OFFER' }, NOW)).toBeNull();
    expect(transitionOf(seen, null, NOW)).toBeNull();
    // a late rebuild of an older version than the one seen
    expect(transitionOf({ ...seen, status: 'UNDER_OFFER', version: 5 }, active(), NOW)).toBeNull();
  });

  it('[S5-06] a listing’s keys cover every saved search that could match it (inverse index)', () => {
    const keys = new Set(listingKeys({ transactionType: 'SALE', locationIds: ['es', 'mlg', 'mbl'] }));
    expect(keys.size).toBe(8);
    const hits = (s: { transactionType: string | null; locationIds: string[] }) =>
      searchKeys(s).some((k) => keys.has(k));
    expect(hits({ transactionType: null, locationIds: [] })).toBe(true);
    expect(hits({ transactionType: 'SALE', locationIds: ['mbl', 'elsewhere'] })).toBe(true);
    expect(hits({ transactionType: null, locationIds: ['es'] })).toBe(true);
    expect(hits({ transactionType: 'RENT_LONG_TERM', locationIds: [] })).toBe(false);
    expect(hits({ transactionType: 'SALE', locationIds: ['elsewhere'] })).toBe(false);
    expect(searchKeys({ transactionType: 'SALE', locationIds: ['b', 'a', 'a'] })).toEqual(['SALE:a', 'SALE:b']);
  });
});
