import { describe, expect, it } from 'vitest';
import { cacheControl, etagFor, weakCompareEtag, weakEtag } from './index';

describe('cacheControl', () => {
  it('[S0-03] builds the feed-api header with SWR and stale-if-error', () => {
    expect(cacheControl.feed({ sMaxAge: 300 })).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=300, stale-if-error=86400',
    );
    expect(cacheControl.feed({ sMaxAge: 60, maxAge: 10, staleWhileRevalidate: 120, staleIfError: 600 })).toBe(
      'public, max-age=10, s-maxage=60, stale-while-revalidate=120, stale-if-error=600',
    );
  });

  it('[S0-03] builds private, immutable and no-store headers', () => {
    expect(cacheControl.private()).toBe('private, max-age=0, must-revalidate');
    expect(cacheControl.immutable()).toBe('public, max-age=31536000, immutable');
    expect(cacheControl.noStore()).toBe('no-store');
  });

  it('[S0-03] rejects invalid TTLs', () => {
    expect(() => cacheControl.feed({ sMaxAge: -1 })).toThrow(RangeError);
    expect(() => cacheControl.private(1.5)).toThrow(RangeError);
  });
});

describe('ETag', () => {
  it('[S0-03] is strong, quoted and stable for the same content', () => {
    const tag = etagFor('{"id":1}');
    expect(tag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(etagFor('{"id":1}')).toBe(tag);
    expect(etagFor('{"id":2}')).not.toBe(tag);
  });

  it('[S0-03] If-None-Match uses weak comparison over lists and *', () => {
    const tag = etagFor('body');
    expect(weakCompareEtag(tag, tag)).toBe(true);
    expect(weakCompareEtag(weakEtag(tag), tag)).toBe(true);
    expect(weakCompareEtag(`"other", ${weakEtag(tag)}`, tag)).toBe(true);
    expect(weakCompareEtag(['"a"', tag], tag)).toBe(true);
    expect(weakCompareEtag('*', tag)).toBe(true);
    expect(weakCompareEtag('"other"', tag)).toBe(false);
    expect(weakCompareEtag(undefined, tag)).toBe(false);
  });
});
