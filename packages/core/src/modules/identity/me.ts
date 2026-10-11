import type { MeDto } from '@inmolink/contracts';

/** What the API knows about the caller from a verified access token (no database read). */
export interface SessionClaims {
  userId: string;
  /** Null for users without an agency (staff). */
  agencyId: string | null;
  sessionVersion: number;
  tokenExpiresAt: Date;
}

/**
 * `GET /v1/me` (S0-09; a service since S1-F4): who the access token belongs to. Read from the token
 * alone — the route stays free of database round trips; revocation is handled at the mint. No `ctx`
 * (exception to rule 4): there is no transaction, tenant work or actor policy here, only the claims.
 */
export function getMe(claims: SessionClaims): MeDto {
  return {
    userId: claims.userId,
    agencyId: claims.agencyId,
    sessionVersion: claims.sessionVersion,
    tokenExpiresAt: claims.tokenExpiresAt.toISOString(),
  };
}
