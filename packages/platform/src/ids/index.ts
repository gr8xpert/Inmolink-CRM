import { randomBytes, randomInt } from 'node:crypto';
import { clock } from '../clock';

/**
 * UUIDv7 (RFC 9562): 48-bit Unix ms timestamp, then a 12-bit counter in `rand_a`
 * (method 1, "fixed bit-length dedicated counter") and 62 random bits.
 * Within one process, ids are strictly increasing even when many share a millisecond
 * or the clock steps backwards, so they sort by creation time as text and as `uuid`.
 */
const COUNTER_MAX = 0xfff;
let lastMs = -1;
let counter = 0;

export function newId(): string {
  let ms = clock.nowMs();
  if (ms > lastMs) {
    lastMs = ms;
    // Random start in the lower half leaves room for ~2k ids in the same ms.
    counter = randomInt(0, 0x800);
  } else {
    ms = lastMs;
    counter += 1;
    if (counter > COUNTER_MAX) {
      // Counter exhausted: borrow the next millisecond rather than lose ordering.
      lastMs += 1;
      ms = lastMs;
      counter = 0;
    }
  }

  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | (counter >> 8);
  b[7] = counter & 0xff;
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);

  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

/** Creation time encoded in a UUIDv7. */
export function uuidV7Time(id: string): Date {
  if (!isUuidV7(id)) throw new TypeError('Not a UUIDv7');
  return new Date(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16));
}

/**
 * Public listing references: `INL-` + 7 Crockford base32 chars (35 bits).
 * Random, so they leak no volume or order. The DB unique index catches the rare
 * collision; callers retry with a fresh ref. Site prefixes are applied at serialization.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REF_LENGTH = 7;
export const LISTING_REF_PREFIX = 'INL-';
const LISTING_REF = /^INL-[0-9A-HJKMNP-TV-Z]{7}$/;

export function newListingRef(): string {
  const bytes = randomBytes(REF_LENGTH);
  let out = LISTING_REF_PREFIX;
  for (const byte of bytes) out += CROCKFORD[byte & 31];
  return out;
}

export function isListingRef(value: string): boolean {
  return LISTING_REF.test(value);
}

/** Normalizes user input (case, I/L → 1, O → 0) before lookup. Returns null when not a ref. */
export function normalizeListingRef(value: string): string | null {
  const v = value.trim().toUpperCase();
  if (!v.startsWith(LISTING_REF_PREFIX)) return null;
  const body = v.slice(LISTING_REF_PREFIX.length).replace(/[IL]/g, '1').replace(/O/g, '0');
  const ref = LISTING_REF_PREFIX + body;
  return isListingRef(ref) ? ref : null;
}

/**
 * Request ids: UUIDv7, so logs sort naturally. A well-formed inbound id is kept for
 * correlation; apps accept it only from the trusted edge hop (S0-08), never from clients.
 * Neither ids nor refs are secrets: use `newToken()` from platform/crypto for tokens.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestIdFrom(inbound: string | undefined | null): string {
  return inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : newId();
}

/** Test hook: forget the last timestamp so a fake clock earlier in the file does not leak. */
export function _resetIdStateForTests(): void {
  lastMs = -1;
  counter = 0;
}
