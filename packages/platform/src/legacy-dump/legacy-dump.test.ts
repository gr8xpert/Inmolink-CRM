import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { LegacyDbError, legacyConnectionString } from './index';

const BASE = 'postgres://reader:secret@legacy.example:5432/inmolink';

const refusal = (fn: () => unknown) => {
  try {
    fn();
    return 'none';
  } catch (err) {
    return err instanceof LegacyDbError ? err.code : 'other';
  }
};

/** What pg makes of the connection string (no connection is opened). */
const sslOf = (url: string) => (new pg.Client({ connectionString: url }) as unknown as { ssl: unknown }).ssl;

/** pg warns once per process that `verify-ca` is read as `verify-full`; kept out of the test output. */
function withoutWarnings<T>(fn: () => T): T {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return fn();
  } finally {
    process.emitWarning = emit;
  }
}

describe('legacy database TLS (S15 review)', () => {
  it('[S15-F4] production refuses a legacy URL without a verified TLS certificate: sslmode missing, disable, allow, prefer, require or no-verify', () => {
    for (const q of [
      '',
      '?sslmode=disable',
      '?sslmode=allow',
      '?sslmode=prefer',
      '?sslmode=no-verify',
      // S15 review: encrypted but unverified (libpq) — open to a man in the middle.
      '?sslmode=require',
      '?sslmode=require&uselibpqcompat=true',
      '?ssl=true',
      // pg keeps a repeated parameter's last value: the check must not read a different one.
      '?sslmode=verify-full&sslmode=require&uselibpqcompat=true',
      '?sslmode=verify-full&uselibpqcompat=false&uselibpqcompat=true',
      '?sslmode=verify-full&ssl=false',
    ]) {
      expect(
        refusal(() => legacyConnectionString(`${BASE}${q}`, true)),
        q,
      ).toBe('LEGACY_DB_TLS_REQUIRED');
    }
    // verify-ca without the CA to check against is no verification at all.
    expect(refusal(() => legacyConnectionString(`${BASE}?sslmode=verify-ca`, true))).toBe('LEGACY_DB_TLS_REQUIRED');
    // The URL checks still come first (no options / timeouts).
    expect(refusal(() => legacyConnectionString(`${BASE}?sslmode=verify-full&options=-c%20x`, true))).toBe(
      'LEGACY_DB_BAD_URL',
    );
  });

  it('[S15-F4] production accepts verify-full / verify-ca with sslrootcert unchanged: pg verifies the certificate and host', () => {
    const full = legacyConnectionString(`${BASE}?sslmode=verify-full`, true);
    expect(full).toBe(`${BASE}?sslmode=verify-full`);
    expect(new URL(full).searchParams.has('uselibpqcompat')).toBe(false);
    expect(sslOf(full)).toEqual({});
    expect(sslOf(full)).not.toHaveProperty('rejectUnauthorized');
    expect(sslOf(full)).not.toHaveProperty('checkServerIdentity');

    const dir = mkdtempSync(join(tmpdir(), 'legacy-tls-'));
    try {
      const ca = join(dir, 'ca.pem');
      writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
      const url = `${BASE}?sslmode=verify-ca&sslrootcert=${encodeURIComponent(ca)}`;
      const pinned = legacyConnectionString(url, true);
      expect(pinned).toBe(url);
      expect(new URL(pinned).searchParams.has('uselibpqcompat')).toBe(false);
      // pg reads verify-ca as verify-full (host checked too), with the pinned CA.
      const ssl = withoutWarnings(() => sslOf(pinned));
      expect(ssl).toMatchObject({ ca: expect.stringContaining('BEGIN CERTIFICATE') });
      expect(ssl).not.toHaveProperty('rejectUnauthorized');
      expect(ssl).not.toHaveProperty('checkServerIdentity');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('[S15-F4] local and test stacks connect as before (the URL as given)', () => {
    expect(legacyConnectionString(BASE, false)).toBe(BASE);
    expect(legacyConnectionString(`${BASE}?sslmode=disable`, false)).toBe(`${BASE}?sslmode=disable`);
  });
});
