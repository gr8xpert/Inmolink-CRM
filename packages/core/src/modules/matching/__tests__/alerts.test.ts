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

  it('[S5-06] a listing’s keys reach its owner’s own searches and, only when shared, the open network’s', () => {
    const owner = 'A';
    const listing = { ownerAgencyId: owner, transactionType: 'SALE', locationIds: ['es', 'mlg', 'mbl'] };
    const shared = new Set(listingKeys({ ...listing, network: true }));
    const unshared = new Set(listingKeys({ ...listing, network: false }));
    expect(shared.size).toBe(2 + 8);
    expect(unshared.size).toBe(2);
    const hits = (
      keys: Set<string>,
      s: { agencyId: string; scope: string; transactionType: string | null; locationIds: string[] },
      open = true,
    ) => searchKeys(s, open).some((k) => keys.has(k));
    const own = { agencyId: owner, scope: 'ALL', transactionType: null, locationIds: [] };
    const other = { agencyId: 'B', scope: 'ALL', transactionType: null, locationIds: [] };
    // the owner's own searches, shared or not; another agency's own-stock search never
    expect(hits(unshared, own)).toBe(true);
    expect(hits(unshared, { ...own, scope: 'OWN', transactionType: 'SALE' })).toBe(true);
    expect(hits(unshared, { ...own, transactionType: 'RENT_LONG_TERM' })).toBe(false);
    expect(hits(shared, { ...other, scope: 'OWN' })).toBe(false);
    // another agency's network search: only for a shared listing, only while its network is open
    expect(hits(unshared, other)).toBe(false);
    expect(hits(shared, other)).toBe(true);
    expect(hits(shared, other, false)).toBe(false);
    expect(hits(shared, { ...other, scope: 'NETWORK', transactionType: 'SALE', locationIds: ['mbl', 'x'] })).toBe(true);
    expect(hits(shared, { ...other, locationIds: ['elsewhere'] })).toBe(false);
    expect(hits(shared, { ...other, transactionType: 'RENT_LONG_TERM' })).toBe(false);
    // keys: one own key, one network key per place, a closed NETWORK search none that a listing probes
    expect(searchKeys({ ...other, transactionType: 'SALE', locationIds: ['b', 'a', 'a'] }, true)).toEqual([
      'net:SALE:a',
      'net:SALE:b',
      'own:B:SALE',
    ]);
    expect(searchKeys({ ...other, scope: 'NETWORK' }, false)).toEqual(['off:B']);
  });
});
