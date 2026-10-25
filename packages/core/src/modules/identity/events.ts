import { MemberRole } from '@inmolink/contracts';
import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * Identity events (PATTERNS §8). IDs only. Anonymous auth flows (`app_auth`) emit platform events (nil
 * agency): the email job loads the user and creates the link token itself, so a token never sits in
 * the outbox. Team changes are the agency's own events (`agencyId` in the payload).
 */
const UserRef = z.object({ userId: z.uuid() });
const ApiKeyChange = z.object({
  agencyId: z.uuid(),
  keyId: z.uuid(),
  actorUserId: z.uuid(),
  impersonatedBy: z.uuid().nullable(),
});

export const identityEvents = {
  /** New account: send the email-confirmation link. */
  registered: defineEvent('identity.user.registered', 1, UserRef),
  /** Sign-up with a taken email: tell the owner instead of revealing it on screen. */
  signupDuplicated: defineEvent('identity.signup.duplicated', 1, UserRef),
  /** Login with an unconfirmed email: send a fresh confirmation link. */
  verificationRequested: defineEvent('identity.verification.requested', 1, UserRef),
  passwordResetRequested: defineEvent('identity.passwordReset.requested', 1, UserRef),
  /** An admin invited someone: send the invite link (S1-02). */
  inviteCreated: defineEvent('identity.invite.created', 1, z.object({ agencyId: z.uuid(), inviteId: z.uuid() })),
  memberRoleChanged: defineEvent(
    'identity.member.roleChanged',
    1,
    z.object({ agencyId: z.uuid(), userId: z.uuid(), role: MemberRole }),
  ),
  /** 2FA was turned on, off, or a recovery code was used (S1-04): for the audit log (S1-08) and notices. */
  twoFactorEnabled: defineEvent('identity.twoFactor.enabled', 1, UserRef),
  twoFactorDisabled: defineEvent('identity.twoFactor.disabled', 1, UserRef),
  recoveryCodeUsed: defineEvent('identity.twoFactor.recoveryCodeUsed', 1, UserRef),
  /** "Remember this browser" was ticked at a challenge: the owner gets a notice (S1-F8). */
  deviceRemembered: defineEvent('identity.twoFactor.deviceRemembered', 1, UserRef),
  /**
   * API keys (S1-05). Revocation and rotation retire a prefix: a subscriber drops its shared cache entry
   * (other processes' copies expire within 15 s). Who acted, and the staff member impersonating them if
   * any, for the audit log (S1-08).
   */
  apiKeyCreated: defineEvent('identity.apiKey.created', 1, ApiKeyChange),
  apiKeyRotated: defineEvent('identity.apiKey.rotated', 1, ApiKeyChange.extend({ retiredPrefix: z.string().max(40) })),
  apiKeyRevoked: defineEvent('identity.apiKey.revoked', 1, ApiKeyChange.extend({ retiredPrefix: z.string().max(40) })),
  /** A key's rate tier changed (S7-08, system only): its cached lookup leaves the shared cache. */
  apiKeyTierChanged: defineEvent(
    'identity.apiKey.tierChanged',
    1,
    z.object({ agencyId: z.uuid(), keyId: z.uuid(), prefix: z.string().max(40), tier: z.enum(['STANDARD', 'HIGH']) }),
  ),
  /** The member can no longer log in or reach the agency. */
  memberDeactivated: defineEvent('identity.member.deactivated', 1, z.object({ agencyId: z.uuid(), userId: z.uuid() })),
  /** The user's sessions were revoked (`session_version` moved on, e.g. a password reset): realtime closes them (S12-F10). */
  sessionsRevoked: defineEvent('identity.sessions.revoked', 1, UserRef),
};
