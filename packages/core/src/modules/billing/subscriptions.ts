import { FREE_PLAN } from '@inmolink/contracts';
import { subscribe } from '@inmolink/platform/outbox';
import * as agencies from '../agencies';
import { billingEvents } from './events';
import { billingJobs } from './jobs';
import { billingNoticeJobs } from './notices';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → billing worker (S13-02, called once by the worker). A new agency's first onboarding (its company details
 * saved for the first time) starts its trial — `billing.startTrial` skips agencies with billing history (migrated,
 * founding, already subscribed). The tenant is `meta.agencyId` (RLS-checked when the event was written).
 */
export function registerBillingSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      agencies.agenciesEvents.detailsUpdated,
      async (payload, meta) => {
        if (payload.firstOnboarding) await billingJobs.startTrial.enqueue({ agencyId: meta.agencyId });
      },
      { name: 'billing.trial.start' },
    ),
    // S13-F22: the admins hear of a failed payment (grace end) and of the agency landing on Free.
    subscribe(
      billingEvents.dunningStarted,
      (payload, meta) =>
        billingNoticeJobs.notifyAdmins.enqueue({
          kind: 'DUNNING',
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          occurredAt: meta.createdAt.toISOString(),
          graceEndsAt: payload.graceEndsAt,
        }),
      { name: 'billing.dunning.notice' },
    ),
    subscribe(
      billingEvents.planChanged,
      async (payload, meta) => {
        if (payload.plan !== FREE_PLAN) return;
        await billingNoticeJobs.notifyAdmins.enqueue({
          kind: 'FREE',
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          occurredAt: meta.createdAt.toISOString(),
        });
      },
      { name: 'billing.free.notice' },
    ),
    // S13 review: a paying agency falling to Free (subscription cancelled or ended) hears of it too — once, on the change
    // to Free; `notifyAdmins` reads the plan in force again before sending.
    subscribe(
      billingEvents.subscriptionChanged,
      async (payload, meta) => {
        if (payload.plan !== FREE_PLAN || payload.previousPlan === FREE_PLAN) return;
        await billingNoticeJobs.notifyAdmins.enqueue({
          kind: 'FREE',
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          occurredAt: meta.createdAt.toISOString(),
        });
      },
      { name: 'billing.free.subscriptionNotice' },
    ),
  ];
}

export function unregisterBillingSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
