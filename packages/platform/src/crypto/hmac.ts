import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { clock } from '../clock';

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

// ── Rotation: the dual-key verify window (S11-F13, docs/runbooks/hmac-key-rotation.md) ────────────────────────────

/**
 * The previous key registered for a current key, and until when it still verifies. Keyed by a SHA-256 of the current
 * key's bytes (not the key itself), so a caller holding `HMAC_KEY` as a string or a Buffer finds the same entry.
 */
const rotations = new Map<string, { previous: Buffer; untilMs: number | null }>();

const keyId = (key: string | Uint8Array): string => createHash('sha256').update(toKey(key)).digest('base64url');

export interface HmacRotationInput {
  /** `HMAC_KEY`: everything is signed and hashed with it. */
  current: string | Uint8Array;
  /** `HMAC_KEY_PREVIOUS`: still accepted by verify and lookups while the window is open; unset closes the window. */
  previous?: string | Uint8Array | undefined;
  /** `HMAC_KEY_PREVIOUS_UNTIL`: the window ends here even if the previous key is still configured. */
  previousUntil?: Date | undefined;
}

/**
 * Boot (every process holding `HMAC_KEY`): opens or closes the dual-key window. With a previous key, the opt-in
 * helpers (`hmacSha256Candidates` for stored-hash lookups, `verifyHmacSha256Rotating`) accept what was made under it
 * until `previousUntil` (or until it is removed from config); `verifyHmacSha256` and signing never use it. Without one,
 * any earlier window for this key is closed.
 */
export function configureHmacRotation(input: HmacRotationInput): void {
  const id = keyId(input.current);
  if (input.previous === undefined || toKey(input.previous).length === 0) {
    rotations.delete(id);
    return;
  }
  const previous = Buffer.from(toKey(input.previous));
  if (previous.equals(toKey(input.current))) throw new Error('HMAC previous key must differ from the current key');
  rotations.set(id, { previous, untilMs: input.previousUntil ? input.previousUntil.getTime() : null });
}

/**
 * Boot helper from validated config (`cryptoEnv`): `configureHmacRotation` with the `HMAC_KEY*` variables. Warns (when
 * given a logger) if the window has already ended: the previous key is then ignored and should be removed from config.
 */
export function hmacRotationFromEnv(
  env: { HMAC_KEY: string; HMAC_KEY_PREVIOUS?: string | undefined; HMAC_KEY_PREVIOUS_UNTIL?: Date | undefined },
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): void {
  if (env.HMAC_KEY_PREVIOUS && env.HMAC_KEY_PREVIOUS_UNTIL && env.HMAC_KEY_PREVIOUS_UNTIL.getTime() <= clock.nowMs()) {
    logger?.warn(
      { until: env.HMAC_KEY_PREVIOUS_UNTIL.toISOString() },
      'HMAC_KEY_PREVIOUS_UNTIL has passed: the previous HMAC key is ignored; remove HMAC_KEY_PREVIOUS from config',
    );
  }
  configureHmacRotation({
    current: env.HMAC_KEY,
    previous: env.HMAC_KEY_PREVIOUS,
    previousUntil: env.HMAC_KEY_PREVIOUS_UNTIL,
  });
}

/**
 * The keys a stored hash under `key` may have been made with right now: the key itself, then its previous key while
 * the window is open. Opt-in: only callers that must survive a rotation (feed-token and fingerprint lookups) use it.
 */
export function hmacKeyCandidates(key: string | Uint8Array): Buffer[] {
  const k = toKey(key);
  const r = rotations.get(keyId(k));
  if (!r || (r.untilMs !== null && clock.nowMs() >= r.untilMs)) return [k];
  return [k, r.previous];
}

/**
 * The stored-lookup side of the window: the hashes `data` may have been stored under — first the current key's (what
 * new rows get), then the previous key's while the window is open. A token lookup (feed URLs) tries them in order and
 * stops at the first hit, so outside a window it is still one hash and one query.
 */
export function hmacSha256Candidates(
  key: string | Uint8Array,
  purpose: HmacPurpose,
  data: string | Uint8Array,
): string[] {
  return hmacKeyCandidates(key).map((k) => hmacSha256(k, purpose, data));
}

/** Constant-time check of a base64url HMAC made by `hmacSha256` — the current key only, never the previous one. */
export function verifyHmacSha256(
  key: string | Uint8Array,
  purpose: HmacPurpose,
  data: string | Uint8Array,
  signature: string,
): boolean {
  return safeEqual(hmacSha256(key, purpose, data), signature);
}

/**
 * S11-F13, opt-in: `verifyHmacSha256` that also accepts a MAC made under the previous key while a rotation window is
 * open — for MACs handed out that must survive a rotation. Every candidate is compared (no early exit).
 */
export function verifyHmacSha256Rotating(
  key: string | Uint8Array,
  purpose: HmacPurpose,
  data: string | Uint8Array,
  signature: string,
): boolean {
  let ok = false;
  for (const candidate of hmacSha256Candidates(key, purpose, data)) ok = safeEqual(candidate, signature) || ok;
  return ok;
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
