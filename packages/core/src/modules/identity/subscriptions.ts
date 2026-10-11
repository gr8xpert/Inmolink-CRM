import { cache } from '@inmolink/platform/cache';
import { type EventDef, subscribe } from '@inmolink/platform/outbox';
import { agenciesEvents } from '../agencies';
import { apiKeyCacheKey, isApiKeyPrefix } from './api-keys';
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

/**
 * Outbox → `identity.sendAuthEmail` / `identity.sendInviteEmail` / `identity.sendVerificationDecisionEmail`,
 * one job per event; API key cache invalidation and `identity.syncApiKeyAgencyStatus` (S1-05). Called once
 * by the worker; idempotent.
 */
export function registerIdentitySubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    ...EMAIL_FOR.map(([def, kind]) =>
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
    ),
    subscribe(
      identityEvents.inviteCreated,
      (payload, meta) => identityJobs.sendInviteEmail.enqueue({ eventId: meta.eventId, ...payload }),
      { name: 'identity.email.INVITE' },
    ),
    subscribe(
      agenciesEvents.verificationDecided,
      (payload, meta) =>
        identityJobs.sendVerificationDecisionEmail.enqueue({
          eventId: meta.eventId,
          agencyId: payload.agencyId,
          requestId: payload.requestId,
        }),
      { name: 'identity.email.VERIFICATION_DECISION' },
    ),
    // API keys (S1-05): a revoked or rotated prefix leaves the shared lookup cache when the event is
    // delivered; in-process copies elsewhere expire within 15 s (all of it within 60 s without the event).
    ...[identityEvents.apiKeyRevoked, identityEvents.apiKeyRotated].map((def) =>
      subscribe(
        def,
        async (payload) => {
          if (isApiKeyPrefix(payload.retiredPrefix)) await cache.delete(apiKeyCacheKey(payload.retiredPrefix));
        },
        { name: `identity.apiKeyCache.${def.type.split('.').at(-1)}` },
      ),
    ),
    subscribe(
      agenciesEvents.statusChanged,
      (payload, meta) =>
        identityJobs.syncApiKeyAgencyStatus.enqueue({ eventId: meta.eventId, agencyId: payload.agencyId }),
      { name: 'identity.apiKeys.agencyStatus' },
    ),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterIdentitySubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
