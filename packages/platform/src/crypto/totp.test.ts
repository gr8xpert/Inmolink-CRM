import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, matchTotp, totpCode, totpStep, totpUri } from './index';

// RFC 6238 Appendix B: SHA-1 seed "12345678901234567890", 8-digit codes; we use the last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it('[S1-04] matches the RFC 6238 SHA-1 test vectors', () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, totpStep(new Date(seconds * 1000)))).toBe(code.slice(-6));
    }
  });

  it('[S1-04] base32 round-trips and tolerates spaces, dashes and lower case', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = base32Encode(bytes);
    expect(base32Decode(text)).toEqual(bytes);
    expect(base32Decode(text.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(bytes);
    expect(() => base32Decode('0189')).toThrow();
  });

  it('[S1-04] new secrets are 160-bit base32 and differ', () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });

  it('[S1-04] accepts the current step and one either side, and returns the matched step', () => {
    const secret = generateTotpSecret();
    const at = new Date(Date.UTC(2026, 9, 11, 12, 0, 15));
    const step = totpStep(at);
    expect(matchTotp(secret, totpCode(secret, step), at)).toBe(step);
    expect(matchTotp(secret, totpCode(secret, step - 1), at)).toBe(step - 1);
    expect(matchTotp(secret, totpCode(secret, step + 1), at)).toBe(step + 1);
    expect(matchTotp(secret, totpCode(secret, step - 2), at)).toBeNull();
    expect(matchTotp(secret, 'abcdef', at)).toBeNull();
    expect(matchTotp(secret, '12345', at)).toBeNull();
  });

  it('[S1-04] builds an otpauth URI with issuer and account', () => {
    const uri = totpUri({ issuer: 'Inmolink', account: 'ana@example.com', secret: 'JBSWY3DPEHPK3PXP' });
    expect(uri).toBe(
      'otpauth://totp/Inmolink:ana%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Inmolink&algorithm=SHA1&digits=6&period=30',
    );
  });
});
