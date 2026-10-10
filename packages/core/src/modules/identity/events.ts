import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * Identity events (PATTERNS §8). Emitted by anonymous auth flows (`app_auth`), so they are platform
 * events (nil agency). IDs only: the email job loads the user and creates the link token itself, so a
 * token never sits in the outbox.
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
};
