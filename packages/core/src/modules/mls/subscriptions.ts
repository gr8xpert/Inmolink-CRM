import { subscribe } from '@inmolink/platform/outbox';
import * as crm from '../crm';
import { mlsJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → mls worker. S11-01: each `crm.contact.merged` event becomes one `mls.repointRegistrations` job (job ID = the
 * event's id: a redelivered event adds nothing) — a merge moves the closed contact's client registrations to the
 * survivor (crm's `CONTACT_REFERENCES` covers crm tables only). The tenant is `meta.agencyId` (RLS-checked when the
 * event was written), the fair-share group. Called once by the worker.
 */
export function registerMlsSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      crm.crmEvents.contactMerged,
      (payload, meta) =>
        mlsJobs.repointRegistrations.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          survivorId: payload.survivorId,
          mergedId: payload.mergedId,
        }),
      { name: 'mls.registrations.contactMerged' },
    ),
  ];
}

export function unregisterMlsSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
