import { hmacKeyCandidates, hmacSha256, type Keyring, rowCipher } from '@inmolink/platform/crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';

/**
 * Process settings for mls, set once at boot (api: registers clients; worker: the fingerprint rehash during an HMAC
 * rotation). Configuration only — never tenant or user state (CLAUDE.md rule 4).
 */
export interface MlsConfig {
  /** `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID`: a registered client's details are stored encrypted. */
  keyring: Keyring;
  /** `HMAC_KEY`: client fingerprints (purpose `mls.client-fingerprint`). */
  fingerprintKey: string;
}

let current: { keyring: Keyring; key: Buffer } | undefined;

export function configureMls(config: MlsConfig): void {
  if (!config.fingerprintKey) throw new Error('mls: fingerprintKey is required');
  // One Buffer for the process: platform/crypto caches the HKDF subkey per key object.
  current = { keyring: config.keyring, key: Buffer.from(config.fingerprintKey) };
}

export const mlsConfigured = (): boolean => current !== undefined;

function configured(): { keyring: Keyring; key: Buffer } {
  if (!current) throw new Error('mls is not configured (call configureMls at boot)');
  return current;
}

const FINGERPRINT_PURPOSE = 'mls.client-fingerprint';

/**
 * A client's identifiers in the one form they are fingerprinted in: e-mails trimmed and lower-cased (no provider alias
 * rules such as Gmail dots — a different address is a different identifier), phones as E.164 (an invalid number is
 * left out). Not trusted from the caller's stored form.
 */
function identifiers(client: { emails: readonly string[]; phones: readonly string[] }): string[] {
  const values = new Set<string>();
  for (const raw of client.emails) {
    const email = raw.trim().toLowerCase();
    if (email.length >= 3) values.add(`email:${email}`);
  }
  for (const raw of client.phones) {
    const phone = parsePhoneNumberFromString(raw.trim().replace(/^00(?=[1-9])/, '+'));
    if (phone?.isValid()) values.add(`phone:${phone.number}`);
  }
  return [...values];
}

export interface ClientFingerprints {
  /** Under the current `HMAC_KEY`: what a new registration must at least carry. Sorted. */
  current: string[];
  /** Every key candidate's (the previous key's too while a rotation window is open, S11-F13). Sorted. */
  candidates: string[];
}

/**
 * A client's keyed fingerprints (PLAN §7 M10): HMAC-SHA256 with `HMAC_KEY` of each normalized identifier, tagged by
 * kind (`email:` / `phone:`), so two agencies holding the same e-mail or phone get the same value, and nobody without
 * the key can reverse it or test a guess. Not per agency on purpose: matching is across agencies. During an HMAC
 * rotation window a registration stores every candidate, so the exclusion constraint compares both keys.
 */
export function clientFingerprints(client: {
  emails: readonly string[];
  phones: readonly string[];
}): ClientFingerprints {
  const { key } = configured();
  const values = identifiers(client);
  const keys = hmacKeyCandidates(key);
  const hash = (k: Buffer) => values.map((v) => hmacSha256(k, FINGERPRINT_PURPOSE, v));
  const currentPrints = [...new Set(hash(key))].sort();
  const candidates = [...new Set(keys.flatMap(hash))].sort();
  return { current: currentPrints, candidates };
}

/** Whether a rotation window is open (the rehash job has work only then). */
export const rotationWindowOpen = (): boolean => hmacKeyCandidates(configured().key).length > 1;

export const RegisteredClient = z.strictObject({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
});
export type RegisteredClient = z.infer<typeof RegisteredClient>;

/**
 * A registered client's details, encrypted (`rowCipher`): bound to the agency, table, column and registration, so a
 * value copied elsewhere does not decrypt. `encrypt(agencyId, registrationId, client)` / `decrypt(...)`.
 */
export const registeredClientCipher = rowCipher(
  'client_registrations',
  'details_enc',
  () => configured().keyring,
  RegisteredClient,
);
