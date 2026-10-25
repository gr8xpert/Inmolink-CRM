import {
  REALTIME_SESSION_NAMESPACE,
  REALTIME_SESSION_REVOKED_EVENT,
  type SessionRevokedPush,
} from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { markSessionRevoked, publishUserEvents, type UserEvent } from '@inmolink/platform/cache';
import { ACCESS_TOKEN_TTL_SECONDS } from '@inmolink/platform/jwt';
import * as sessionsRepo from './sessions-repo';

/**
 * S12-F10: realtime sockets outlive the checks the api makes on every request, so a deactivation or a session
 * revocation is (1) stored in redis-cache for every realtime node, for as long as a token issued before it lives
 * (`markSessionRevoked`: a restarted node or one that missed the message still refuses the old token), then
 * (2) pushed to apps/realtime (pub/sub, `SessionRevokedPush`), which closes that member's sockets on every per-user
 * namespace. Called by the outbox subscribers (outside any transaction); at least once — both steps are idempotent.
 */

type Publish = (events: readonly UserEvent[], options?: { everyNode?: boolean }) => Promise<void>;
type Store = typeof markSessionRevoked;

/** A user belongs to one agency (`agency_members_user_uq`); a few, should that ever change. */
const MAX_MEMBERSHIPS = 20;

const revoked = (userId: string, agencyId: string, data: SessionRevokedPush): UserEvent => ({
  userId,
  agencyId,
  namespace: REALTIME_SESSION_NAMESPACE,
  event: REALTIME_SESSION_REVOKED_EVENT,
  data,
});

/** Worker side (`withSystem`): which (agency, user) pairs are active members, any role (`agencyId:userId` keys). */
export async function activeMembersAcross(
  tx: Tx,
  pairs: readonly { agencyId: string; userId: string }[],
): Promise<Set<string>> {
  return sessionsRepo.activeMembersAcross(tx, pairs);
}

/**
 * `identity.member.deactivated`: every socket of the member in that agency whose token was issued before the
 * deactivation (database time) closes. A member active again by now is left alone.
 */
export async function disconnectDeactivatedMember(
  p: { agencyId: string; userId: string },
  publish: Publish = publishUserEvents,
  store: Store = markSessionRevoked,
): Promise<{ revoked: boolean }> {
  const at = await withSystem('identity.disconnectDeactivatedMember', (tx) =>
    sessionsRepo.memberDeactivatedAt(tx, p.agencyId, p.userId),
  );
  if (!at) return { revoked: false };
  await store(p.agencyId, p.userId, { deactivatedAt: at.getTime() }, ACCESS_TOKEN_TTL_SECONDS);
  // every node records it (not only those with a socket of the member): redis-cache's copy may be evicted
  await publish([revoked(p.userId, p.agencyId, { sessionVersion: null, deactivatedAt: at.toISOString() })], {
    everyNode: true,
  });
  return { revoked: true };
}

/**
 * `identity.sessions.revoked` (password reset): the user's sockets in each of their agencies whose token carries an
 * older `session_version` close. Reads the current version (a retry of an older event cannot close a newer session).
 */
export async function disconnectRevokedSessions(
  p: { userId: string },
  publish: Publish = publishUserEvents,
  store: Store = markSessionRevoked,
): Promise<{ agencies: number }> {
  const scope = await withSystem('identity.disconnectRevokedSessions', (tx) =>
    sessionsRepo.sessionScope(tx, p.userId, MAX_MEMBERSHIPS),
  );
  if (!scope || scope.agencyIds.length === 0) return { agencies: 0 };
  for (const agencyId of scope.agencyIds) {
    await store(agencyId, p.userId, { sessionVersion: scope.sessionVersion }, ACCESS_TOKEN_TTL_SECONDS);
  }
  await publish(
    scope.agencyIds.map((a) => revoked(p.userId, a, { sessionVersion: scope.sessionVersion, deactivatedAt: null })),
    { everyNode: true },
  );
  return { agencies: scope.agencyIds.length };
}
