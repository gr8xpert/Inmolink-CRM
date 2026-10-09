import { afterEach, describe, expect, it } from 'vitest';
import { restoreClock, useFakeClock } from '../clock';
import {
  _resetIdStateForTests,
  isListingRef,
  isUuidV7,
  newId,
  newListingRef,
  normalizeListingRef,
  requestIdFrom,
  uuidV7Time,
} from './index';

afterEach(() => {
  restoreClock();
  _resetIdStateForTests();
});

describe('newId (UUIDv7)', () => {
  it('[S0-03] UUIDv7 values sort by creation time', () => {
    const fake = useFakeClock('2026-10-10T00:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 5000; i++) {
      ids.push(newId());
      if (i % 7 === 0) fake.advance(1); // many ids share a millisecond, some do not
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('[S0-03] stays ordered when the clock steps backwards', () => {
    const fake = useFakeClock('2026-10-10T00:00:01Z');
    const a = newId();
    fake.advance(-500);
    const b = newId();
    expect(b > a).toBe(true);
  });

  it('[S0-03] has the v7 layout and encodes its timestamp', () => {
    useFakeClock('2026-10-10T12:34:56.789Z');
    const id = newId();
    expect(isUuidV7(id)).toBe(true);
    expect(uuidV7Time(id).toISOString()).toBe('2026-10-10T12:34:56.789Z');
  });
});

describe('listing refs', () => {
  it('[S0-03] are INL- plus 7 Crockford base32 chars', () => {
    for (let i = 0; i < 200; i++) expect(isListingRef(newListingRef())).toBe(true);
  });

  it('[S0-03] normalize ambiguous user input', () => {
    expect(normalizeListingRef(' inl-0ab1ixo ')).toBe('INL-0AB11X0');
    expect(normalizeListingRef('ABC-1234567')).toBeNull();
    expect(normalizeListingRef('INL-12345')).toBeNull();
  });
});

describe('requestIdFrom', () => {
  it('[S0-03] keeps a safe inbound id and replaces unsafe ones', () => {
    expect(requestIdFrom('abc-12345678')).toBe('abc-12345678');
    expect(isUuidV7(requestIdFrom('bad id\n with newline'))).toBe(true);
    expect(isUuidV7(requestIdFrom(undefined))).toBe(true);
  });
});
