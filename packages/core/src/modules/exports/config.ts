import { hmacSha256, type Keyring, rowCipher } from '@inmolink/platform/crypto';
import { z } from 'zod';

/**
 * Process settings for exports, set once at boot (api: encrypts credentials and hashes feed tokens; worker and the
 * feed server later decrypt and verify). Configuration only — never tenant or user state (CLAUDE.md rule 4).
 */
export interface ExportsConfig {
  /**
   * `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID` (platform/crypto, AES-256-GCM with key IDs). Optional (S9-03):
   * feed-api only verifies feed tokens and never holds the encryption keys.
   */
  keyring?: Keyring;
  /** `HMAC_KEY`: feed tokens are stored as their keyed hash (purpose `exports.feed-token`). */
  tokenKey: string;
}

let current: ExportsConfig | undefined;

export function configureExports(config: ExportsConfig): void {
  if (!config.tokenKey) throw new Error('exports: tokenKey is required');
  current = config;
}

function configured(): ExportsConfig {
  if (!current) throw new Error('exports is not configured (call configureExports at boot)');
  return current;
}

const tokenKey = (): Buffer => Buffer.from(configured().tokenKey);

/**
 * The hash a feed token is stored as (`token_hash`): HMAC-SHA256 with `HMAC_KEY`, purpose `exports.feed-token`. The
 * service hashes a new token with it; the feed server (S9-03) hashes the presented one the same way.
 */
export const portalFeedTokenHash = (token: string): string => hmacSha256(tokenKey(), 'exports.feed-token', token);

/**
 * S10-F7, the idempotent create: the token of a connection made with an `Idempotency-Key`, derived from the agency,
 * the connection's id and the key (never stored). A new row has a new id, so a key reused after a delete gets a new token.
 */
export const portalDerivedToken = (agencyId: string, connectionId: string, idempotencyKey: string): string =>
  hmacSha256(tokenKey(), 'exports.feed-token-derived', `${agencyId}:${connectionId}:${idempotencyKey}`);

/** HMAC of the agency's `Idempotency-Key` (the stored `idempotency_hash`). */
export const portalIdempotencyHash = (agencyId: string, idempotencyKey: string): string =>
  hmacSha256(tokenKey(), 'exports.connection-idempotency', `${agencyId}:${idempotencyKey}`);

/** HMAC of the create request's body: the same key with another body is refused. */
export const portalRequestHash = (canonicalJson: string): string =>
  hmacSha256(tokenKey(), 'exports.connection-request', canonicalJson);

function keyring(): Keyring {
  const k = configured().keyring;
  if (!k) throw new Error('exports: no keyring configured (credentials cannot be encrypted or decrypted here)');
  return k;
}

/**
 * A portal connection's credentials, encrypted (S10-F3: `rowCipher`). Ciphertext is bound to the agency, table,
 * column and row: copied elsewhere it does not decrypt. Decrypting is worker-side (the push engine); the API only
 * encrypts. `encrypt(agencyId, connectionId, credentials)` / `decrypt(...)`.
 */
export const portalCredentialsCipher = rowCipher(
  'agency_portal_connections',
  'credentials_enc',
  keyring,
  z.record(z.string(), z.string()),
);

/** Feed runs kept per connection (the generator deletes older ones in each run's transaction; S10-F1: out of the service). */
export const FEED_RUNS_KEPT = 30;
