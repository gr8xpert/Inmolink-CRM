import { aadFor, type Keyring } from '@inmolink/platform/crypto';

/**
 * Process settings for exports, set once at boot (api: encrypts credentials and hashes feed tokens; worker and the
 * feed server later decrypt and verify). Configuration only — never tenant or user state (CLAUDE.md rule 4).
 */
export interface ExportsConfig {
  /** `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID` (platform/crypto, AES-256-GCM with key IDs). */
  keyring: Keyring;
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

export const tokenKey = (): Buffer => Buffer.from(configured().tokenKey);

/** Ciphertext is bound to the agency, table, column and row: copied elsewhere it does not decrypt. */
const aad = (agencyId: string, connectionId: string) =>
  aadFor({ agencyId, table: 'agency_portal_connections', column: 'credentials_enc', rowId: connectionId });

export function encryptCredentials(
  agencyId: string,
  connectionId: string,
  credentials: Record<string, string>,
): string {
  return configured().keyring.encrypt(JSON.stringify(credentials), aad(agencyId, connectionId));
}

export function decryptCredentials(agencyId: string, connectionId: string, envelope: string): Record<string, string> {
  return JSON.parse(configured().keyring.decrypt(envelope, aad(agencyId, connectionId))) as Record<string, string>;
}
