import { withSystem } from '@inmolink/db';
import { cache } from '@inmolink/platform/cache';
import { type EventDef, subscribe } from '@inmolink/platform/outbox';
import { agenciesEvents } from '../agencies';
import { apiKeyCacheKey, isApiKeyPrefix } from './api-keys';
import type { AuthEmailKind, TwoFactorNoticeKind } from './emails';
import { identityEvents } from './events';
import { identityJobs } from './jobs';
import * as repo from './repo';
import { disconnectDeactivatedMember, disconnectRevokedSessions } from './sessions';

const EMAIL_FOR: [EventDef, AuthEmailKind][] = [
  [identityEvents.registered, 'VERIFY_EMAIL'],
  [identityEvents.verificationRequested, 'VERIFY_EMAIL'],
  [identityEvents.passwordResetRequested, 'PASSWORD_RESET'],
  [identityEvents.signupDuplicated, 'ACCOUNT_EXISTS'],
];

const TWO_FACTOR_NOTICE_FOR: [EventDef, TwoFactorNoticeKind][] = [
  [identityEvents.twoFactorEnabled, 'enabled'],
  [identityEvents.twoFactorDisabled, 'disabled'],
  [identityEvents.recoveryCodeUsed, 'recoveryUsed'],
  [identityEvents.deviceRemembered, 'deviceRemembered'],
];

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → `identity.sendAuthEmail` / `identity.sendInviteEmail` / `identity.sendVerificationDecisionEmail`,
 * one job per event (per admin for the verification decision); API key cache invalidation and `identity.syncApiKeyAgencyStatus` (S1-05). Called once
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
    ...TWO_FACTOR_NOTICE_FOR.map(([def, kind]) =>
      subscribe(
        def,
        (payload, meta) =>
          identityJobs.sendTwoFactorNotice.enqueue({
            eventId: meta.eventId,
            userId: (payload as { userId: string }).userId,
            kind,
          }),
        { name: `identity.email.twoFactor.${kind}` },
      ),
    ),
    subscribe(
      identityEvents.inviteCreated,
      (payload, meta) => identityJobs.sendInviteEmail.enqueue({ eventId: meta.eventId, ...payload }),
      { name: 'identity.email.INVITE' },
    ),
    subscribe(
      agenciesEvents.verificationDecided,
      async (payload, meta) => {
        // One job per admin (S1-F7). Enqueueing again for the same event is a no-op (`jobId`).
        const admins = await withSystem('identity.email.VERIFICATION_DECISION', (tx) =>
          repo.listAdminRecipients(tx, payload.agencyId),
        );
        for (const admin of admins) {
          await identityJobs.sendVerificationDecisionEmail.enqueue({
            eventId: meta.eventId,
            agencyId: payload.agencyId,
            requestId: payload.requestId,
            userId: admin.userId,
          });
        }
      },
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
    // S7-08: a changed tier is read on the key's next lookup.
    subscribe(
      identityEvents.apiKeyTierChanged,
      async (payload) => {
        if (isApiKeyPrefix(payload.prefix)) await cache.delete(apiKeyCacheKey(payload.prefix));
      },
      { name: 'identity.apiKeyCache.tierChanged' },
    ),
    subscribe(
      agenciesEvents.statusChanged,
      (payload, meta) =>
        identityJobs.syncApiKeyAgencyStatus.enqueue({ eventId: meta.eventId, agencyId: payload.agencyId }),
      { name: 'identity.apiKeys.agencyStatus' },
    ),
    // S12-F10: a deactivated member's or a revoked session's realtime sockets close (one small pub/sub publish)
    subscribe(
      identityEvents.memberDeactivated,
      (payload) => disconnectDeactivatedMember(payload).then(() => undefined),
      {
        name: 'identity.realtime.memberDeactivated',
      },
    ),
    subscribe(identityEvents.sessionsRevoked, (payload) => disconnectRevokedSessions(payload).then(() => undefined), {
      name: 'identity.realtime.sessionsRevoked',
    }),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterIdentitySubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
