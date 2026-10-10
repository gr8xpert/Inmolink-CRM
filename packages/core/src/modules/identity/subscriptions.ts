import { type EventDef, subscribe } from '@inmolink/platform/outbox';
import type { AuthEmailKind } from './emails';
import { identityEvents } from './events';
import { identityJobs } from './jobs';

const EMAIL_FOR: [EventDef, AuthEmailKind][] = [
  [identityEvents.registered, 'VERIFY_EMAIL'],
  [identityEvents.verificationRequested, 'VERIFY_EMAIL'],
  [identityEvents.passwordResetRequested, 'PASSWORD_RESET'],
  [identityEvents.signupDuplicated, 'ACCOUNT_EXISTS'],
];

let unsubscribe: (() => void)[] | undefined;

/** Outbox → `identity.sendAuthEmail`, one job per event. Called once by the worker; idempotent. */
export function registerIdentitySubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = EMAIL_FOR.map(([def, kind]) =>
    subscribe(
      def,
      (payload, meta) =>
        identityJobs.sendAuthEmail.enqueue({
          eventId: meta.eventId,
          userId: (payload as { userId: string }).userId,
          kind,
        }),
      { name: `identity.email.${kind}` },
    ),
  );
}

/** Tests: drop the subscriptions again. */
export function unregisterIdentitySubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
