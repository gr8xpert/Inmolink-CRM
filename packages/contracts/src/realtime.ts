import { z } from 'zod';

/**
 * S12-F10: a control event workers publish per user (redis-cache pub/sub, like `/notifications` pushes) when a member
 * is deactivated or their sessions are revoked (password reset bumps `session_version`). It never reaches a browser:
 * apps/realtime disconnects that user's sockets of that agency on every per-user namespace and refuses the old token
 * on reconnect. `deactivatedAt` set = every socket whose token was issued before it (deactivation); `sessionVersion`
 * set = sockets whose token carries an older version (a token minted after the reset keeps its socket).
 */
export const REALTIME_SESSION_NAMESPACE = '/session';
export const REALTIME_SESSION_REVOKED_EVENT = 'revoked';
export const SessionRevokedPush = z.strictObject({
  sessionVersion: z.number().int().nonnegative().nullable(),
  /** Deactivation: when the database deactivated the member (tokens issued up to ~1 s after it are refused). */
  deactivatedAt: z.iso.datetime().nullable(),
});
export type SessionRevokedPush = z.infer<typeof SessionRevokedPush>;
