import { subscribe } from '@inmolink/platform/outbox';
import * as websites from '../websites';
import { websiteApiJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → speed-to-lead (S7-05): a website lead queues the visitor's acknowledgement and the agency's notification,
 * one job each per lead (enqueueing again for a redelivered event is a no-op: `jobId`). Called once by the worker;
 * idempotent.
 */
export function registerWebsiteApiSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      websites.websitesEvents.leadReceived,
      async (payload, meta) => {
        const job = { eventId: meta.eventId, leadId: payload.leadId, agencyId: payload.agencyId };
        await Promise.all([
          websiteApiJobs.sendLeadAcknowledgement.enqueue(job),
          websiteApiJobs.notifyLeadAgency.enqueue(job),
        ]);
      },
      { name: 'websiteApi.lead.received' },
    ),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterWebsiteApiSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
