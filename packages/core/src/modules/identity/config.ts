import type { Keyring } from '@inmolink/platform/crypto';
import type { AccessTokenSigner } from '@inmolink/platform/jwt';

/**
 * Process settings for identity, set once at boot (web: signer + HMAC key; worker: web URL + HMAC
 * key). Configuration only — never tenant or user state (CLAUDE.md rule 4).
 */
export interface IdentityConfig {
  /** `HMAC_KEY`: link tokens are stored as HMACs. */
  hmacKey: string;
  /** `WEB_URL`, for links in emails (worker). */
  webUrl?: string;
  /** Mints access tokens (web). */
  signer?: AccessTokenSigner;
  /** Encrypts TOTP secrets (web, S1-04). */
  keyring?: Keyring;
}

let current: IdentityConfig | undefined;

export function configureIdentity(config: IdentityConfig): void {
  current = config;
}

export function identityConfig(): IdentityConfig {
  if (!current) throw new Error('identity is not configured (call configureIdentity at boot)');
  return current;
}

/** Email link lifetimes (S0-09: reset links expire in 60 minutes; S1-02: invites in 7 days). */
export const TOKEN_TTL_MS = {
  EMAIL_VERIFY: 24 * 60 * 60_000,
  PASSWORD_RESET: 60 * 60_000,
  INVITE: 7 * 24 * 60 * 60_000,
} as const;

/**
 * Seats (members + open invites) an agency may fill before staff verify it (S1-02 security review M2):
 * invites send email under our domain, so an unverified sign-up must not become a mailing tool.
 */
export const UNVERIFIED_SEAT_CAP = 5;

/** Expired (or used) link tokens are kept this long for support, then pruned (S1-F4). */
export const TOKEN_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Two-factor (S1-04, PLAN §3 #30). */
export const TWO_FACTOR = {
  /** Shown in the authenticator app next to the account. */
  ISSUER: 'Inmolink',
  RECOVERY_CODES: 10,
  /** "Remember this browser" skips the challenge for 30 days. */
  REMEMBER_DEVICE_MS: 30 * 24 * 60 * 60_000,
  /** A passed challenge is handed to the session within this window. */
  PROOF_TTL_MS: 2 * 60_000,
} as const;
