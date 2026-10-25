import * as identity from '@inmolink/core/modules/identity';

/**
 * S12-06 review: whether the signed-in session is in Client Mode — its cookie's flag, or the server-side state of the
 * session (an older copy of the cookie may not carry the flag). Pages and actions a client must never reach (security
 * settings, two-factor changes) send such a session away. Fails closed: when the state cannot be read, it counts.
 */
export async function inClientMode(user: { id: string; clientMode?: boolean; sessionId?: string }): Promise<boolean> {
  if (user.clientMode) return true;
  try {
    return (await identity.activeClientModeOf({ userId: user.id, sessionId: user.sessionId ?? null })) !== null;
  } catch {
    return true;
  }
}
