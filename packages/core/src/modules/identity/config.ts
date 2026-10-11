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
  /**
   * The `<env>` part of API keys this process issues and accepts (S1-05): `live` in production, `test`
   * elsewhere, so a staging key never works against production. Default `test`.
   */
  apiKeyEnv?: ApiKeyEnv;
}

export type ApiKeyEnv = 'live' | 'test';

/** `live` for the production deploy (`DEPLOY_ENV`, defaulting to `NODE_ENV`), `test` for every other. */
export function apiKeyEnvFor(deployEnv: string | undefined): ApiKeyEnv {
  return deployEnv === 'production' ? 'live' : 'test';
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

/** Website API keys (S1-05, PLAN §3 #30 §9.2). */
export const API_KEYS = {
  /** Active (not revoked) keys per agency. */
  MAX_ACTIVE: 20,
  /** Revoked keys stay in the dashboard list this long. */
  REVOKED_LISTED_MS: 30 * 24 * 60 * 60_000,
  /**
   * Lookup cache (S1-05 acceptance "revoked key rejected within 60 s"): Redis keeps a key ≤ 25 s and a
   * process's copy ≤ 15 s, so even with the invalidation event lost, a revoked or rotated key is refused
   * after ≤ 40 s plus the time the load took.
   */
  CACHE_TTL_SECONDS: 25,
  CACHE_LOCAL_TTL_SECONDS: 15,
  /** A process records a key's use in Redis at most once a minute; the worker writes it every minute. */
  USAGE_MARK_INTERVAL_MS: 60_000,
  USAGE_FLUSH_EVERY_MS: 60_000,
  /** Requests per key per minute on the website API, by the key's tier. */
  RATE_TIERS: {
    STANDARD: { limit: 600, windowSeconds: 60 },
    HIGH: { limit: 3_000, windowSeconds: 60 },
  },
  /** All keys of one agency together, per minute: extra keys do not multiply the ceiling. */
  AGENCY_RATE: { limit: 3_000, windowSeconds: 60 },
  /** Failed key checks per client IP per minute before `requireApiKey` answers 429. */
  FAILED_CHECKS_PER_IP: { limit: 60, windowSeconds: 60 },
} as const;
