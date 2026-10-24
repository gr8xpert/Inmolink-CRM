import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Contact identifiers in the one form they are stored and compared in (S10-01): duplicate detection is an exact
 * match on these, so every writer (form, import, later leads) goes through here.
 */

/** Trimmed and lower-cased; null when it is not an e-mail address (a light check: the contracts did the strict one). */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * E.164 (`+34600123456`), or null when the number is not valid. A number without an international prefix is read
 * as a number of `country`; `00` is read as `+`.
 */
export function normalizePhone(raw: string, country: string): string | null {
  const text = raw.trim().replace(/^00(?=[1-9])/, '+');
  if (text.length < 3 || text.length > 40) return null;
  const parsed = parsePhoneNumberFromString(text, country as CountryCode);
  if (!parsed?.isValid()) return null;
  return parsed.number;
}

/** Distinct values in first-seen order. */
export function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
