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
}

let current: IdentityConfig | undefined;

export function configureIdentity(config: IdentityConfig): void {
  current = config;
}

export function identityConfig(): IdentityConfig {
  if (!current) throw new Error('identity is not configured (call configureIdentity at boot)');
  return current;
}

/** Email link lifetimes (S0-09 acceptance: reset links expire in 60 minutes). */
export const TOKEN_TTL_MS = {
  EMAIL_VERIFY: 24 * 60 * 60_000,
  PASSWORD_RESET: 60 * 60_000,
} as const;
