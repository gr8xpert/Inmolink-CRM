import { configureHmacRotation, createKeyring, generateKey, hmacKeyLabel, hmacSha256 } from '@inmolink/platform/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { clientFingerprints, configureMls, rotationWindowOpen } from '../config';

const KEY = 'mls-unit-fingerprint-key-0123456789abcdef';
const OLD = 'mls-unit-previous-fingerprint-key-0123456789';
const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });
const print = (key: string, value: string) => hmacSha256(Buffer.from(key), 'mls.client-fingerprint', value);

afterEach(() => {
  configureHmacRotation({ current: KEY });
});

describe('client fingerprints', () => {
  it('[S11-01] e-mails are trimmed and lower-cased, phones normalized to E.164 (never trusted as stored)', () => {
    configureMls({ keyring, fingerprintKey: KEY });
    const a = clientFingerprints({ emails: [' Ana.Lopez@Example.COM '], phones: ['0034 600 123 456'] });
    const b = clientFingerprints({ emails: ['ana.lopez@example.com'], phones: ['+34600123456'] });
    expect(a).toEqual(b);
    expect(a.current).toEqual([print(KEY, 'email:ana.lopez@example.com'), print(KEY, 'phone:+34600123456')].sort());
    // an invalid phone is left out; no provider alias rules (a Gmail dot makes another identifier)
    expect(clientFingerprints({ emails: [], phones: ['12'] }).current).toEqual([]);
    expect(clientFingerprints({ emails: ['a.na@gmail.com'], phones: [] })).not.toEqual(
      clientFingerprints({ emails: ['ana@gmail.com'], phones: [] }),
    );
  });

  it('[S11-01] during an HMAC rotation window the previous key’s fingerprints are candidates too', () => {
    configureMls({ keyring, fingerprintKey: KEY });
    expect(rotationWindowOpen()).toBe(false);
    const client = { emails: ['rot@example.com'], phones: [] };
    expect(clientFingerprints(client)).toEqual({
      current: [print(KEY, 'email:rot@example.com')],
      candidates: [print(KEY, 'email:rot@example.com')],
      // S12-F8: each candidate with the label of the key that made it (stored as `key_id`)
      keyed: [{ fingerprint: print(KEY, 'email:rot@example.com'), keyId: hmacKeyLabel(KEY) }],
    });
    configureHmacRotation({ current: KEY, previous: OLD });
    expect(rotationWindowOpen()).toBe(true);
    const candidates = [print(KEY, 'email:rot@example.com'), print(OLD, 'email:rot@example.com')].sort();
    expect(clientFingerprints(client)).toEqual({
      current: [print(KEY, 'email:rot@example.com')],
      candidates,
      keyed: candidates.map((fingerprint) => ({
        fingerprint,
        keyId: hmacKeyLabel(fingerprint === print(KEY, 'email:rot@example.com') ? KEY : OLD),
      })),
    });
  });
});
