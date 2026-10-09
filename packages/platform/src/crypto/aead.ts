import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM with key IDs for stored secrets and PII (PLAN §12).
 *
 * Envelope: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts). The key ID picks
 * the decryption key, so old values stay readable after rotation; `needsReencrypt()`
 * finds values to move to the active key.
 *
 * Associated data is required: build it with `aadFor({ agencyId, table, column, rowId })`
 * so a ciphertext copied to another row, column or tenant fails decryption.
 */
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;

export class DecryptError extends Error {
  override readonly name = 'DecryptError';
}

export interface AadParts {
  agencyId: string | null;
  table: string;
  column: string;
  rowId: string;
}

/** Unambiguous AAD (JSON array) binding a value to tenant, table, column and row. */
export function aadFor(parts: AadParts): string {
  return JSON.stringify(['inl-aad-v1', parts.agencyId, parts.table, parts.column, parts.rowId]);
}

export interface Keyring {
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
  encrypt(plaintext: string | Uint8Array, aad: string): string;
  decrypt(envelope: string, aad: string): string;
  decryptBytes(envelope: string, aad: string): Buffer;
  keyIdOf(envelope: string): string;
  needsReencrypt(envelope: string): boolean;
  /** Decrypts with whichever key wrote it and encrypts again with the active key. */
  reencrypt(envelope: string, aad: string): string;
}

export interface KeyringInput {
  /** keyId → 32-byte key (raw bytes or base64). */
  keys: Record<string, Uint8Array | string>;
  activeKeyId: string;
}

function decodePart(part: string, bytes?: number): Buffer {
  if (!B64URL.test(part)) throw new DecryptError('Malformed ciphertext');
  const buf = Buffer.from(part, 'base64url');
  // Reject non-canonical encodings and wrong sizes.
  if (buf.toString('base64url') !== part || (bytes !== undefined && buf.length !== bytes)) {
    throw new DecryptError('Malformed ciphertext');
  }
  return buf;
}

export function createKeyring(input: KeyringInput): Keyring {
  const keys = new Map<string, Buffer>();
  for (const [id, raw] of Object.entries(input.keys)) {
    if (!KEY_ID.test(id)) throw new Error(`Invalid encryption key id "${id}" (use [A-Za-z0-9_-], max 32 chars)`);
    const key = typeof raw === 'string' ? Buffer.from(raw, 'base64') : Buffer.from(raw);
    if (key.length !== KEY_BYTES) throw new Error(`Encryption key "${id}" must be ${KEY_BYTES} bytes`);
    keys.set(id, key);
  }
  if (!keys.has(input.activeKeyId))
    throw new Error(`Active encryption key "${input.activeKeyId}" is not in the keyring`);
  const activeKeyId = input.activeKeyId;

  function parse(envelope: string) {
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new DecryptError('Malformed ciphertext');
    const [, keyId = '', iv = '', tag = '', data = ''] = parts;
    if (!KEY_ID.test(keyId)) throw new DecryptError('Malformed ciphertext');
    return { keyId, iv: decodePart(iv, IV_BYTES), tag: decodePart(tag, TAG_BYTES), data: decodePart(data) };
  }

  function encrypt(plaintext: string | Uint8Array, aad: string): string {
    const key = keys.get(activeKeyId) as Buffer;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, activeKeyId, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join(
      '.',
    );
  }

  function decryptBytes(envelope: string, aad: string): Buffer {
    const { keyId, iv, tag, data } = parse(envelope);
    const key = keys.get(keyId);
    if (!key) throw new DecryptError(`Unknown encryption key id "${keyId}"`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      throw new DecryptError('Ciphertext failed authentication');
    }
  }

  return {
    activeKeyId,
    keyIds: [...keys.keys()],
    encrypt,
    decryptBytes,
    decrypt: (envelope, aad) => decryptBytes(envelope, aad).toString('utf8'),
    keyIdOf: (envelope) => parse(envelope).keyId,
    needsReencrypt: (envelope) => parse(envelope).keyId !== activeKeyId,
    reencrypt: (envelope, aad) => encrypt(decryptBytes(envelope, aad), aad),
  };
}

/**
 * Parses `ENCRYPTION_KEYS` — comma-separated `keyId:base64Key` pairs, e.g.
 * `k2026a:BASE64,k2026b:BASE64`. Rotation = add a key, switch `ENCRYPTION_ACTIVE_KEY_ID`,
 * run the re-encrypt job, then remove the old key.
 */
export function parseKeyList(value: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) throw new Error('ENCRYPTION_KEYS entries must look like keyId:base64Key');
    const id = trimmed.slice(0, sep);
    if (id in keys) throw new Error(`Duplicate encryption key id "${id}"`);
    keys[id] = trimmed.slice(sep + 1);
  }
  return keys;
}

/** A new random 32-byte key, base64 — for `ENCRYPTION_KEYS`. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/** Builds the keyring from validated config (`cryptoEnv` in platform/config). */
export function keyringFromEnv(env: { ENCRYPTION_KEYS: string; ENCRYPTION_ACTIVE_KEY_ID: string }): Keyring {
  return createKeyring({ keys: parseKeyList(env.ENCRYPTION_KEYS), activeKeyId: env.ENCRYPTION_ACTIVE_KEY_ID });
}
