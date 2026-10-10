/**
 * Identity rules (PATTERNS §6). Auth flows have no actor yet, so these take the user row instead of
 * `ctx`; tenant roles (`can(ctx, …)`) arrive with memberships (S1-02).
 */
export interface LoginSubject {
  status: string;
  emailVerifiedAt: Date | null;
}

export type LoginDecision = 'ok' | 'invalid' | 'unverified';

/** After the password matched. Disabled accounts look like a wrong password (no account probing). */
export function loginDecision(user: LoginSubject): LoginDecision {
  if (user.status !== 'ACTIVE') return 'invalid';
  if (!user.emailVerifiedAt) return 'unverified';
  return 'ok';
}

/** An access token is minted only for an active, verified user whose session was not revoked. */
export function canIssueAccessToken(user: LoginSubject & { sessionVersion: number }, sessionVersion: number): boolean {
  return loginDecision(user) === 'ok' && user.sessionVersion === sessionVersion;
}
