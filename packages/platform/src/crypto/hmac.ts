import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 with the dedicated `HMAC_KEY`. Every call names a purpose
 * (`fingerprint`, `idempotency`, `api-key`, …); a subkey is derived per purpose with
 * HKDF, so a MAC made for one purpose is never valid for another.
 */
export type HmacPurpose = string;

const subkeys = new WeakMap<object, Map<string, Buffer>>();

function subkey(key: Buffer, purpose: HmacPurpose): Buffer {
  if (!purpose) throw new Error('HMAC purpose is required');
  let cache = subkeys.get(key);
  if (!cache) {
    cache = new Map();
    subkeys.set(key, cache);
  }
  let k = cache.get(purpose);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `inl-hmac:${purpose}`, 32));
    cache.set(purpose, k);
  }
  return k;
}

function toKey(key: string | Uint8Array): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(key);
}

export function hmacSha256(key: string | Uint8Array, purpose: HmacPurpose, data: string | Uint8Array): string {
  return createHmac('sha256', subkey(toKey(key), purpose))
    .update(data)
    .digest('base64url');
}

export function hmacSha256Hex(key: string | Uint8Array, purpose: HmacPurpose, data: string | Uint8Array): string {
  return createHmac('sha256', subkey(toKey(key), purpose))
    .update(data)
    .digest('hex');
}

/** Constant-time check of a base64url HMAC made by `hmacSha256`. */
export function verifyHmacSha256(
  key: string | Uint8Array,
  purpose: HmacPurpose,
  data: string | Uint8Array,
  signature: string,
): boolean {
  return safeEqual(hmacSha256(key, purpose, data), signature);
}

/**
 * Constant-time check of a raw (no purpose subkey) hex HMAC-SHA256 — for third-party
 * webhook signatures that are computed with the provider's secret directly.
 */
export function verifyRawHmacSha256Hex(secret: string | Uint8Array, data: string | Uint8Array, hex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const expected = createHmac('sha256', secret).update(data).digest();
  return timingSafeEqual(expected, Buffer.from(hex, 'hex'));
}

/** Constant-time string comparison; false on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Unguessable token (32 random bytes, base64url) for reset links, invites and share
 * links. Never use `newId()` or listing refs for these — they are time-ordered or short.
 */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
