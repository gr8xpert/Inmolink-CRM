import { subscribe } from '@inmolink/platform/outbox';
import { networkEvents } from './events';
import { networkJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → network worker (S11-05). Each published post becomes a `network.notifySubscribers` job — a buyer request a
 * `network.matchBuyerRequest` job, which queues it (job IDs = the post: a redelivered event adds nothing). The tenant is
 * `meta.agencyId` (RLS-checked when the post was written), the fair-share group. Called once by the worker.
 */
export function registerNetworkSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      networkEvents.postPublished,
      async (payload, meta) => {
        const job = { postId: payload.postId, agencyId: meta.agencyId };
        // a buyer request's subscribers are notified after its matching (that job queues it): one notification each
        if (payload.kind === 'BUYER_REQUEST') await networkJobs.matchBuyerRequest.enqueue(job);
        else await networkJobs.notifySubscribers.enqueue(job);
      },
      { name: 'network.posts.published' },
    ),
    // S12-F12: a closed post's reply threads become read-only
    subscribe(
      networkEvents.postClosed,
      (payload, meta) => networkJobs.closePostThreads.enqueue({ postId: payload.postId, agencyId: meta.agencyId }),
      { name: 'network.posts.closed' },
    ),
  ];
}

export function unregisterNetworkSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
