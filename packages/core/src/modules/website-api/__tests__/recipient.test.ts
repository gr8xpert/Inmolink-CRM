import { describe, expect, it } from 'vitest';
import { canonicalRecipient } from '../leads';

describe('website-api acknowledgement recipient', () => {
  it('[S7-05] aliases of one mailbox share the per-recipient cap hash', () => {
    expect(canonicalRecipient('  Ana.Lopez+promo@Example.COM ')).toBe('ana.lopez@example.com');
    expect(canonicalRecipient('ana.lopez@example.com')).toBe('ana.lopez@example.com');
    // Gmail ignores dots and googlemail.com is the same mailbox.
    for (const alias of ['a.n.a@gmail.com', 'ANA+x@googlemail.com', 'an.a+1+2@GMail.com', 'ana@gmail.com']) {
      expect(canonicalRecipient(alias)).toBe('ana@gmail.com');
    }
    // Dots matter elsewhere; an address that starts with `+` or has no `@` is kept as is (lowercased).
    expect(canonicalRecipient('a.na@example.com')).not.toBe(canonicalRecipient('ana@example.com'));
    expect(canonicalRecipient('+tag@example.com')).toBe('+tag@example.com');
    expect(canonicalRecipient('Not-An-Address')).toBe('not-an-address');
  });
});
