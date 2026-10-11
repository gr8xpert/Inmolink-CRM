import { MemberRole } from '@inmolink/contracts';
import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * Identity events (PATTERNS §8). IDs only. Anonymous auth flows (`app_auth`) emit platform events (nil
 * agency): the email job loads the user and creates the link token itself, so a token never sits in
 * the outbox. Team changes are the agency's own events (`agencyId` in the payload).
 */
const UserRef = z.object({ userId: z.uuid() });

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
  /** The member can no longer log in or reach the agency. */
  memberDeactivated: defineEvent('identity.member.deactivated', 1, z.object({ agencyId: z.uuid(), userId: z.uuid() })),
};
