import { translator } from '@inmolink/i18n/server';
import { describe, expect, it } from 'vitest';
import { verifyAgainst } from '../signatures';
import { auditTrailHtml } from '../signatures-audit';
import { drawnSignature, signedName } from '../signing-public';
import {
  configureSigning,
  maskedEmail,
  readSigningToken,
  signingCode,
  signingCodeMatches,
  signingToken,
  signingUrl,
} from '../signing-token';

/** Signing links, codes, the signature's input checks and the audit trail (R2-05b): pure, no DB. */

const AGENCY = '01900000-0000-7000-8000-0000000000a1';
const SIGNER = '01900000-0000-7000-8000-0000000000b2';
const OTP = '01900000-0000-7000-8000-0000000000c3';
configureSigning({ tokenKey: 'unit-test-signing-key-0123456789abcdef', publicBaseUrl: 'https://sites.test/' });

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('[R2-05b] signing links and codes', () => {
  it('[R2-05b] a signing token names one signer of one agency and cannot be altered', () => {
    const token = signingToken(AGENCY, SIGNER);
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(readSigningToken(token)).toEqual({ agencyId: AGENCY, signerId: SIGNER });
    const flipped = `${token.slice(0, 10)}${token[10] === 'A' ? 'B' : 'A'}${token.slice(11)}`;
    expect(readSigningToken(flipped)).toBeNull();
    expect(readSigningToken('x'.repeat(64))).toBeNull();
    expect(signingUrl({ agencyId: AGENCY, signerId: SIGNER, locale: 'es' })).toBe(
      `https://sites.test/sign/${token}?l=es`,
    );
    expect(signingUrl({ agencyId: AGENCY, signerId: SIGNER, locale: 'en' }, '/signed')).toBe(
      `https://sites.test/sign/${token}/signed?l=en`,
    );
  });

  it('[R2-05b] the one-time code is 6 digits derived from its row and signer (never stored), checked in constant time', () => {
    const code = signingCode(OTP, SIGNER);
    expect(code).toMatch(/^\d{6}$/);
    expect(signingCode(OTP, SIGNER)).toBe(code);
    expect(signingCode('01900000-0000-7000-8000-0000000000c4', SIGNER)).not.toBe(code);
    expect(signingCodeMatches(OTP, SIGNER, code)).toBe(true);
    expect(signingCodeMatches(OTP, '01900000-0000-7000-8000-0000000000b3', code)).toBe(false);
    expect(signingCodeMatches(OTP, SIGNER, `${code}0`)).toBe(false);
    expect(maskedEmail('bruno@example.com')).toBe('b•••@example.com');
  });

  it('[R2-05b] the signature: a one-line name; a drawn PNG checked by magic bytes, size and dimensions', () => {
    expect(signedName('  Ana\tMaría \u0000 López ')).toBe('Ana María López');
    expect(signedName('   ')).toBeNull();
    expect(signedName('x'.repeat(201))).toBeNull();
    expect(drawnSignature(PNG)).toMatch(/^iVBORw0KGgo/);
    expect(drawnSignature('data:image/png;base64,R0lGODlhAQABAAAAACw=')).toBeNull();
    expect(drawnSignature('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(drawnSignature(`data:image/png;base64,${'A'.repeat(100_000)}`)).toBeNull();
    // ancillary chunks (here a tEXt before IEND) are dropped; a broken chunk structure is refused
    const png = Buffer.from(PNG.split(',')[1] as string, 'base64');
    const text = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('tEXtevil'), Buffer.alloc(4)]);
    const withText = Buffer.concat([png.subarray(0, png.length - 12), text, png.subarray(png.length - 12)]);
    expect(drawnSignature(`data:image/png;base64,${withText.toString('base64')}`)).toBe(png.toString('base64'));
    const truncated = png.subarray(0, png.length - 4);
    expect(drawnSignature(`data:image/png;base64,${truncated.toString('base64')}`)).toBeNull();
  });

  it('[R2-05b] verification compares a file with the stored hashes', () => {
    const bytes = new TextEncoder().encode('%PDF-signed');
    const row = { id: SIGNER, documentSha256: 'a'.repeat(64), signedSha256: null };
    expect(verifyAgainst(row, bytes).match).toBe('NONE');
    const signed = verifyAgainst(row, bytes).sha256;
    expect(verifyAgainst({ ...row, signedSha256: signed }, bytes).match).toBe('SIGNED');
    expect(verifyAgainst({ ...row, documentSha256: signed }, bytes).match).toBe('ORIGINAL');
  });

  it('[R2-05b] the audit trail lists signers, UTC times, IPs, browsers and the original hash, every value escaped', () => {
    const html = auditTrailHtml({
      t: translator('en', 'documents'),
      lang: 'en',
      agencyName: 'Costa <Homes>',
      documentLabel: 'REF-1 · Bruno',
      formId: AGENCY,
      requestId: SIGNER,
      requestedAt: new Date('2026-11-07T10:00:00Z'),
      allSignedAt: new Date('2026-11-07T12:00:00Z'),
      originalSha256: 'f'.repeat(64),
      signers: [
        {
          position: 1,
          role: 'Client (buyer)',
          name: 'Bruno <script>',
          email: 'bruno@example.com',
          invitedAt: '2026-11-07T10:00:01Z',
          codeSentAt: '2026-11-07T11:00:00Z',
          signedAt: '2026-11-07T11:05:00Z',
          signatureKind: 'DRAWN',
          signatureText: 'Bruno B',
          signaturePng: 'iVBORw0KGgo=',
          documentSha256: 'f'.repeat(64),
          ip: '203.0.113.7',
          userAgent: 'Mozilla "x"',
        },
      ],
    });
    for (const text of [
      'bruno@example.com',
      '2026-11-07T11:05:00Z',
      '2026-11-07T11:00:00Z',
      '203.0.113.7',
      'f'.repeat(64),
      'Costa &lt;Homes&gt;',
      'Bruno &lt;script&gt;',
      'Mozilla &quot;x&quot;',
      'data:image/png;base64,iVBORw0KGgo=',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('<script');
  });
});
