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

describe('legacy database TLS (S15 review)', () => {
  it('[S15-F4] production refuses a legacy URL without TLS: sslmode missing, disable, allow or prefer', () => {
    for (const q of ['', '?sslmode=disable', '?sslmode=allow', '?sslmode=prefer', '?sslmode=no-verify']) {
      expect(
        refusal(() => legacyConnectionString(`${BASE}${q}`, true)),
        q,
      ).toBe('LEGACY_DB_TLS_REQUIRED');
    }
    // verify-ca without the CA to check against is no verification at all.
    expect(refusal(() => legacyConnectionString(`${BASE}?sslmode=verify-ca`, true))).toBe('LEGACY_DB_TLS_REQUIRED');
    // The URL checks still come first (no options / timeouts).
    expect(refusal(() => legacyConnectionString(`${BASE}?sslmode=require&options=-c%20x`, true))).toBe(
      'LEGACY_DB_BAD_URL',
    );
  });

  it('[S15-F4] production accepts require / verify-full with libpq meanings: encrypted, verified as asked', () => {
    const required = legacyConnectionString(`${BASE}?sslmode=require`, true);
    expect(new URL(required).searchParams.get('uselibpqcompat')).toBe('true');
    expect(sslOf(required)).toMatchObject({ rejectUnauthorized: false });
    const full = legacyConnectionString(`${BASE}?sslmode=verify-full`, true);
    expect(sslOf(full)).toEqual({});
    expect(sslOf(full)).not.toHaveProperty('rejectUnauthorized');
  });

  it('[S15-F4] local and test stacks connect as before (the URL as given)', () => {
    expect(legacyConnectionString(BASE, false)).toBe(BASE);
    expect(legacyConnectionString(`${BASE}?sslmode=disable`, false)).toBe(`${BASE}?sslmode=disable`);
  });
});
