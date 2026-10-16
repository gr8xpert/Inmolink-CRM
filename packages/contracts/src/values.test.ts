import { describe, expect, it } from 'vitest';
import { ListingFilter, ListingTag } from './properties';
import { LISTING_FILTER_KEYS, normalizeListingTag } from './values';

describe('plain value lists (S4-F2)', () => {
  it('[S4-F2] the filter keys are ListingFilter’s keys', () => {
    expect([...LISTING_FILTER_KEYS].sort()).toEqual(Object.keys(ListingFilter.shape).sort());
  });

  it('[S4-F2] normalizeListingTag agrees with ListingTag', () => {
    for (const raw of [
      '  Sea View ',
      'x',
      '',
      '   ',
      'a'.repeat(40),
      'a'.repeat(41),
      'bad\u0007tag',
      'ÁTICO',
      '海景',
    ]) {
      const parsed = ListingTag.safeParse(raw);
      expect(normalizeListingTag(raw), JSON.stringify(raw)).toBe(parsed.success ? parsed.data : null);
    }
  });
});
