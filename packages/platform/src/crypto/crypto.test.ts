import { createHmac } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aadFor,
  configureHmacRotation,
  createKeyring,
  DecryptError,
  generateKey,
  hmacKeyCandidates,
  hmacKeyLabel,
  hmacRotationEndsAt,
  hmacRotationFromEnv,
  hmacSha256,
  hmacSha256Candidates,
  keyringFromEnv,
  newToken,
  parseKeyList,
  safeEqual,
  verifyHmacSha256,
  verifyHmacSha256Rotating,
  verifyRawHmacSha256Hex,
} from './index';
import {
  _dummyHashForTests,
  dummyVerify,
  hashPassword,
  needsRehash,
  PasswordTooLongError,
  verifyPassword,
} from './password';

const k1 = generateKey();
const k2 = generateKey();
const aad = aadFor({ agencyId: 'agency-1', table: 'smtp_settings', column: 'password', rowId: 'row-1' });

describe('AES-256-GCM keyring', () => {
  it('[S0-03] encrypt → rotate key → decrypt with old key ID works', () => {
    const before = createKeyring({ keys: { k1 }, activeKeyId: 'k1' });
    const stored = before.encrypt('smtp-password', aad);
    expect(before.keyIdOf(stored)).toBe('k1');

    // Rotation: add k2 and make it active; k1 stays for reading.
    const after = keyringFromEnv({ ENCRYPTION_KEYS: `k1:${k1},k2:${k2}`, ENCRYPTION_ACTIVE_KEY_ID: 'k2' });
    expect(after.decrypt(stored, aad)).toBe('smtp-password');
    expect(after.needsReencrypt(stored)).toBe(true);

    const moved = after.reencrypt(stored, aad);
    expect(after.keyIdOf(moved)).toBe('k2');
    expect(after.needsReencrypt(moved)).toBe(false);

    // Once everything is re-encrypted, k1 can be dropped.
    const final = createKeyring({ keys: { k2 }, activeKeyId: 'k2' });
    expect(final.decrypt(moved, aad)).toBe('smtp-password');
    expect(() => final.decrypt(stored, aad)).toThrow(/Unknown encryption key id "k1"/);
  });

  it('[S0-03] tampered ciphertext is rejected', () => {
    const ring = createKeyring({ keys: { k1 }, activeKeyId: 'k1' });
    const stored = ring.encrypt('secret', aad);
    const [v, id, iv, tag, data = ''] = stored.split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;

    expect(() => ring.decrypt([v, id, iv, tag, flipped.toString('base64url')].join('.'), aad)).toThrow(DecryptError);
    expect(() => ring.decrypt([v, id, iv, Buffer.alloc(16).toString('base64url'), data].join('.'), aad)).toThrow(
      DecryptError,
    );
    expect(() => ring.decrypt('v1.k1.garbage', aad)).toThrow(DecryptError);
    expect(() => ring.decrypt([v, 'bad id!', iv, tag, data].join('.'), aad)).toThrow('Malformed ciphertext');
    expect(() => ring.decrypt([v, id, `${iv}=`, tag, data].join('.'), aad)).toThrow('Malformed ciphertext');
  });

  it('[S0-03] associated data binds a value to its tenant, column and row', () => {
    const ring = createKeyring({ keys: { k1 }, activeKeyId: 'k1' });
    const stored = ring.encrypt('token', aad);
    const otherRow = aadFor({ agencyId: 'agency-1', table: 'smtp_settings', column: 'password', rowId: 'row-2' });
    const otherAgency = aadFor({ agencyId: 'agency-2', table: 'smtp_settings', column: 'password', rowId: 'row-1' });
    expect(() => ring.decrypt(stored, otherRow)).toThrow(DecryptError);
    expect(() => ring.decrypt(stored, otherAgency)).toThrow(DecryptError);
  });

  it('[S0-03] uses a fresh IV per encryption', () => {
    const ring = createKeyring({ keys: { k1 }, activeKeyId: 'k1' });
    expect(ring.encrypt('same', aad)).not.toBe(ring.encrypt('same', aad));
  });

  it('[S0-03] rejects bad key material', () => {
    expect(() => createKeyring({ keys: { k1: 'c2hvcnQ=' }, activeKeyId: 'k1' })).toThrow(/32 bytes/);
    expect(() => createKeyring({ keys: { k1 }, activeKeyId: 'k9' })).toThrow(/not in the keyring/);
    expect(() => createKeyring({ keys: { 'bad.id': k1 }, activeKeyId: 'bad.id' })).toThrow(/Invalid encryption key id/);
  });

  it('[S0-03] parses ENCRYPTION_KEYS lists', () => {
    expect(parseKeyList(`k1:${k1}, k2:${k2}`)).toEqual({ k1, k2 });
    expect(() => parseKeyList('nokey')).toThrow(/keyId:base64Key/);
    expect(() => parseKeyList(`k1:${k1},k1:${k2}`)).toThrow(/Duplicate/);
  });
});

describe('HMAC-SHA256', () => {
  const key = 'a-dedicated-hmac-key-of-32-chars-min';

  it('[S0-03] signs and verifies in constant time', () => {
    const sig = hmacSha256(key, 'idempotency', 'payload');
    expect(verifyHmacSha256(key, 'idempotency', 'payload', sig)).toBe(true);
    expect(verifyHmacSha256(key, 'idempotency', 'payload!', sig)).toBe(false);
    expect(verifyHmacSha256('another-key', 'idempotency', 'payload', sig)).toBe(false);
    expect(safeEqual('a', 'ab')).toBe(false);
  });

  it('[S0-03] separates purposes so a MAC for one is invalid for another', () => {
    const sig = hmacSha256(key, 'fingerprint', 'payload');
    expect(verifyHmacSha256(key, 'idempotency', 'payload', sig)).toBe(false);
    expect(() => hmacSha256(key, '', 'payload')).toThrow(/purpose/);
  });

  it('[S0-03] verifies raw hex webhook signatures', () => {
    const sig = createHmac('sha256', 'whsec').update('body').digest('hex');
    expect(verifyRawHmacSha256Hex('whsec', 'body', sig)).toBe(true);
    expect(verifyRawHmacSha256Hex('whsec', 'body2', sig)).toBe(false);
    expect(verifyRawHmacSha256Hex('whsec', 'body', 'zz')).toBe(false);
  });

  it('[S0-03] makes unguessable tokens', () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(newToken());
  });
});

describe('HMAC_KEY rotation window (S11-F13)', () => {
  const OLD = 'the-previous-hmac-key-of-32-chars-min';
  const NEW = 'the-current-hmac-key-of-32-chars-minimum';
  afterEach(() => {
    configureHmacRotation({ current: NEW });
    vi.useRealTimers();
  });

  it('[S11-F13] signs with the current key only; verifies a MAC of the previous key until the window ends', () => {
    vi.useFakeTimers({ now: new Date('2026-11-01T00:00:00Z') });
    const issued = hmacSha256(OLD, 'exports.feed-token', 'token');
    expect(verifyHmacSha256Rotating(NEW, 'exports.feed-token', 'token', issued)).toBe(false);

    configureHmacRotation({ current: NEW, previous: OLD, previousUntil: new Date('2026-12-01T00:00:00Z') });
    expect(verifyHmacSha256Rotating(NEW, 'exports.feed-token', 'token', issued)).toBe(true);
    // Opt-in only: the plain verify never accepts the previous key, window or not.
    expect(verifyHmacSha256(NEW, 'exports.feed-token', 'token', issued)).toBe(false);
    // Purposes stay separate under the previous key too; the current key still verifies.
    expect(verifyHmacSha256Rotating(NEW, 'api-key', 'token', issued)).toBe(false);
    expect(
      verifyHmacSha256Rotating(NEW, 'exports.feed-token', 'token', hmacSha256(NEW, 'exports.feed-token', 'token')),
    ).toBe(true);
    // Lookups: the current key's hash first (what new rows get), then the previous key's.
    expect(hmacSha256Candidates(NEW, 'exports.feed-token', 'token')).toEqual([
      hmacSha256(NEW, 'exports.feed-token', 'token'),
      issued,
    ]);
    // A Buffer of the same key finds the same window.
    expect(hmacKeyCandidates(Buffer.from(NEW))).toHaveLength(2);

    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));
    expect(verifyHmacSha256Rotating(NEW, 'exports.feed-token', 'token', issued)).toBe(false);
    expect(hmacSha256Candidates(NEW, 'exports.feed-token', 'token')).toHaveLength(1);
  });

  it('[S11-F13] the window closes when the previous key is removed from config; other keys are unaffected', () => {
    hmacRotationFromEnv({ HMAC_KEY: NEW, HMAC_KEY_PREVIOUS: OLD });
    const issued = hmacSha256(OLD, 'p', 'd');
    expect(verifyHmacSha256Rotating(NEW, 'p', 'd', issued)).toBe(true);
    expect(hmacKeyCandidates('some-other-key-of-at-least-32-chars')).toHaveLength(1);
    hmacRotationFromEnv({ HMAC_KEY: NEW });
    expect(verifyHmacSha256Rotating(NEW, 'p', 'd', issued)).toBe(false);
    expect(() => configureHmacRotation({ current: NEW, previous: NEW })).toThrow(/differ/);
  });

  it('[S11-F13] boot warns when HMAC_KEY_PREVIOUS_UNTIL has already passed, and the previous key is ignored', () => {
    const warn = vi.fn();
    const until = new Date(Date.now() - 1000);
    hmacRotationFromEnv({ HMAC_KEY: NEW, HMAC_KEY_PREVIOUS: OLD, HMAC_KEY_PREVIOUS_UNTIL: until }, { warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(OLD);
    expect(hmacKeyCandidates(NEW)).toHaveLength(1);
    warn.mockClear();
    hmacRotationFromEnv(
      { HMAC_KEY: NEW, HMAC_KEY_PREVIOUS: OLD, HMAC_KEY_PREVIOUS_UNTIL: new Date(Date.now() + 60_000) },
      { warn },
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('HMAC key labels and the window end (S12-F8)', () => {
  const CUR = 'label-test-current-key-0123456789abcdef';
  const PREV = 'label-test-previous-key-0123456789abcdef';

  it('[S12-F8] a key label is short, stable, differs per key and is not a hash of the key or of data under it', () => {
    expect(hmacKeyLabel(CUR)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(hmacKeyLabel(Buffer.from(CUR))).toBe(hmacKeyLabel(CUR));
    expect(hmacKeyLabel(PREV)).not.toBe(hmacKeyLabel(CUR));
    expect(hmacSha256(CUR, 'mls.client-fingerprint', 'v1').startsWith(hmacKeyLabel(CUR))).toBe(false);
  });

  it('[S12-F8] hmacRotationEndsAt is the open window’s end, else null', () => {
    vi.useFakeTimers({ now: new Date('2026-11-01T00:00:00Z') });
    try {
      expect(hmacRotationEndsAt(CUR)).toBeNull();
      configureHmacRotation({ current: CUR, previous: PREV });
      expect(hmacRotationEndsAt(CUR)).toBeNull(); // no end set (development)
      const until = new Date('2026-12-01T00:00:00Z');
      configureHmacRotation({ current: CUR, previous: PREV, previousUntil: until });
      expect(hmacRotationEndsAt(CUR)).toEqual(until);
      vi.setSystemTime(until);
      expect(hmacRotationEndsAt(CUR)).toBeNull();
    } finally {
      configureHmacRotation({ current: CUR });
      vi.useRealTimers();
    }
  });
});

describe('Argon2id passwords', () => {
  it('[S0-03] hashes with Argon2id and verifies', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'wrong')).toBe(false);
    expect(needsRehash(stored)).toBe(false);
  });

  it('[S0-03] flags hashes made with weaker parameters for rehash', async () => {
    const weak = await hash('pw', { memoryCost: 4096, timeCost: 1 });
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash('not-a-hash')).toBe(true);
  });

  it('[S0-03] refuses over-long input, malformed and over-costly hashes', async () => {
    await expect(hashPassword('x'.repeat(2000))).rejects.toBeInstanceOf(PasswordTooLongError);
    expect(await verifyPassword('not-a-hash', 'pw')).toBe(false);
    const costly =
      '$argon2id$v=19$m=4194304,t=2,p=1$kSbNzQY3beVrSOBzQ+h8bg$ozAr0LLSh8Ay4w6FuVV1qHD1WwaD0rbpN1ZkT57fy5I';
    expect(await verifyPassword(costly, 'pw')).toBe(false);
  });

  it('[S0-03] dummy verify uses a hash that matches the current policy', async () => {
    expect(needsRehash(_dummyHashForTests)).toBe(false);
    expect(await verifyPassword(_dummyHashForTests, 'inmolink-dummy-password')).toBe(true);
    expect(await dummyVerify('pw')).toBe(false);
  });
});
