import { describe, expect, it } from 'vitest';
import { LegacyPropertiesQuery, LegacyPropertyParams, legacyShimPath } from './legacy-v1';

describe('[S8-02] legacy v1 contract', () => {
  it('[S8-02] legacy paths map to the shim prefix; other paths are left alone', () => {
    expect(legacyShimPath('/api/properties')).toBe('/v1/properties');
    expect(legacyShimPath('/api/properties/1042')).toBe('/v1/properties/1042');
    expect(legacyShimPath('/api')).toBe('/v1');
    expect(legacyShimPath('/apix/properties')).toBe('/apix/properties');
    expect(legacyShimPath('/v2/listings')).toBe('/v2/listings');
  });

  it('[S8-02] legacy queries: unknown parameters dropped, defaults, id lists split, bounds enforced', () => {
    const q = LegacyPropertiesQuery.parse({ lang: 'en', type: '3, 7,', _: '1700000000', utm_source: 'x' });
    expect(q).toEqual({ lang: 'en', type: ['3', '7'], page: 1, limit: 20, sort: 'newest' });
    expect(LegacyPropertiesQuery.safeParse({ page: '0' }).success).toBe(false);
    expect(LegacyPropertiesQuery.safeParse({ limit: '51' }).success).toBe(false);
    expect(LegacyPropertiesQuery.safeParse({ type: "1'; drop" }).success).toBe(false);
    // One legacy name per v2 transaction type: sale, rent (long-term), holiday (short-term).
    expect(LegacyPropertiesQuery.parse({ transaction: 'holiday' }).transaction).toBe('holiday');
    expect(LegacyPropertiesQuery.safeParse({ transaction: 'let' }).success).toBe(false);
    expect(LegacyPropertiesQuery.parse({ min_price: '400000', beds: '2' })).toMatchObject({
      min_price: 400_000,
      beds: 2,
    });
  });

  it('[S8-02] a property id is a legacy id or a site reference, never a path', () => {
    expect(LegacyPropertyParams.safeParse({ id: '1042' }).success).toBe(true);
    expect(LegacyPropertyParams.safeParse({ id: 'GS-7KQ2M9XA' }).success).toBe(true);
    expect(LegacyPropertyParams.safeParse({ id: '../x' }).success).toBe(false);
  });
});
