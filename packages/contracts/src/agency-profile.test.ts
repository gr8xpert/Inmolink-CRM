import { describe, expect, it } from 'vitest';
import { Commission, WebsiteUrl } from './agency-profile';

describe('agency profile contracts', () => {
  it('[S1-06] website URLs are http(s) only, with the scheme lower-cased to match the row CHECK', () => {
    expect(WebsiteUrl.parse('HTTPS://Www.Costa.example/es')).toBe('https://Www.Costa.example/es');
    expect(WebsiteUrl.parse('Http://costa.example')).toBe('http://costa.example');
    for (const bad of ['javascript:alert(1)', 'ftp://costa.example', 'costa.example']) {
      expect(WebsiteUrl.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('[S1-06] a fixed commission is Money: integer cents and an ISO currency', () => {
    const fixed = { type: 'FIXED', amount: { amountCents: 500_000, currency: 'EUR' }, includesVat: true };
    expect(Commission.parse(fixed)).toEqual(fixed);
    expect(Commission.safeParse({ ...fixed, amount: { amountCents: 5.5, currency: 'EUR' } }).success).toBe(false);
    expect(Commission.safeParse({ ...fixed, amount: { amountCents: 100, currency: 'eur' } }).success).toBe(false);
    expect(Commission.safeParse({ type: 'PCT', basisPoints: 10_001, includesVat: false }).success).toBe(false);
  });
});
