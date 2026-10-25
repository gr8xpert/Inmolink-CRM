import { subscribe } from '@inmolink/platform/outbox';
import { socialEvents } from './events';
import { socialJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → social worker (S12-07): a claimed post publishes, a caption request is drafted, an account that needs
 * reconnecting is announced to the admins. Job IDs come from the events (a redelivered event adds nothing).
 */
export function registerSocialSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      socialEvents.postDue,
      (payload, meta) =>
        socialJobs.publishPost.enqueue({
          postId: payload.postId,
          agencyId: meta.agencyId,
          claimedAtMs: payload.claimedAtMs,
        }),
      { name: 'social.post.publish' },
    ),
    subscribe(
      socialEvents.captionsRequested,
      (payload, meta) =>
        socialJobs.generateCaptions.enqueue({
          postId: payload.postId,
          agencyId: meta.agencyId,
          requestId: payload.requestId,
          locales: payload.locales,
        }),
      { name: 'social.captions.generate' },
    ),
    subscribe(
      socialEvents.accountDisconnected,
      (payload, meta) => socialJobs.revokeAccount.enqueue({ agencyId: meta.agencyId, accountId: payload.accountId }),
      { name: 'social.account.revoke' },
    ),
    subscribe(
      socialEvents.accountNeedsReconnect,
      (payload, meta) =>
        socialJobs.notifyReconnect.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          accountId: payload.accountId,
          occurredAt: meta.createdAt.toISOString(),
        }),
      { name: 'social.account.reconnectNotice' },
    ),
  ];
}

export function unregisterSocialSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
