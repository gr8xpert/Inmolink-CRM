import { isAppError } from '@inmolink/platform/errors';
import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, keysetAfter, keysetAfterRaw } from './pagination';

const agencies = pgTable('t', { id: uuid('id'), createdAt: timestamp('created_at', { withTimezone: true }) });
const ID = '01a16d64-ce9d-76b9-86f3-e8b86026e867';
const AT = '2026-10-22T16:31:43.924Z';
const US = '2026-10-22T16:31:43.924123Z';
const raw = (parts: unknown) => Buffer.from(JSON.stringify(parts)).toString('base64url');
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return isAppError(e) ? e.code : 'NOT_AN_APP_ERROR';
  }
  return 'NO_ERROR';
};

describe('keyset cursors', () => {
  it('[S11-F9] a cursor with its microsecond stamp round-trips', () => {
    const c = { at: new Date(AT), id: ID, atUs: US };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('[S11-F9] forged or malformed stamps are VALIDATION_FAILED, never another error', () => {
    for (const us of [
      null,
      7,
      {},
      '',
      'x',
      '2026-10-22T16:31:43.924Z',
      '2026-13-22T16:31:43.924123Z',
      '2026-02-30T16:31:43.924123Z',
      '2026-10-22T25:31:43.924123Z',
      '2026-10-22T16:31:43.925123Z', // disagrees with `at` by 1 ms
      '2026-10-22 16:31:43.924123Z',
    ]) {
      expect(
        code(() => decodeCursor(raw([AT, ID, us]))),
        String(us),
      ).toBe('VALIDATION_FAILED');
    }
    expect(code(() => decodeCursor(raw([AT, ID, US, 'extra'])))).toBe('VALIDATION_FAILED');
    expect(code(() => decodeCursor(raw([AT])))).toBe('VALIDATION_FAILED');
    expect(code(() => decodeCursor(raw({ at: AT })))).toBe('VALIDATION_FAILED');
    expect(code(() => decodeCursor('%%%'))).toBe('VALIDATION_FAILED');
  });

  it('[S11-F9] a two-element cursor is rejected by a raw-column list and accepted by a date_trunc list', () => {
    const old = decodeCursor(raw([AT, ID]));
    expect(code(() => keysetAfterRaw(agencies.createdAt, agencies.id, old, 'asc'))).toBe('VALIDATION_FAILED');
    expect(keysetAfter(agencies.createdAt, agencies.id, old, 'desc')).toBeDefined();
  });

  it('[S11-F9] a three-element cursor still works on a date_trunc list', () => {
    const c = decodeCursor(raw([AT, ID, US]));
    expect(keysetAfter(agencies.createdAt, agencies.id, c, 'desc')).toBeDefined();
    expect(keysetAfterRaw(agencies.createdAt, agencies.id, c, 'desc')).toBeDefined();
  });
});
