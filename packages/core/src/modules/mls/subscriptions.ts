import { subscribe } from '@inmolink/platform/outbox';
import * as crm from '../crm';
import { mlsEvents } from './events';
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
    // S16-04 review: an erased contact's registrations keep their evidence but lose the client's details
    subscribe(
      crm.crmEvents.contactErased,
      (payload, meta) =>
        mlsJobs.eraseContactRegistrations.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          contactId: payload.contactId,
        }),
      { name: 'mls.registrations.contactErased' },
    ),
    // S11-02: each viewing request change notifies the other side (both on expiry)
    subscribe(
      mlsEvents.viewingChanged,
      (payload, meta) =>
        mlsJobs.notifyViewing.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          createdMs: meta.createdAt.getTime(),
          change: payload,
        }),
      { name: 'mls.viewings.notify' },
    ),
    // S12-05: terms both sides accepted get their PDF (the owner's acceptance carries `termsAccepted`).
    subscribe(
      mlsEvents.viewingChanged,
      async (payload, meta) => {
        if (!payload.termsAccepted) return;
        await mlsJobs.queueViewingTermsPdf.enqueue({ eventId: meta.eventId, agencyId: meta.agencyId, change: payload });
      },
      { name: 'mls.viewings.termsPdf' },
    ),
    // R2-04b: each deal change notifies the other party (the job re-reads the deal: staff can write the event for any
    // agency, so the event's agency must prove one of the deal's parties)
    subscribe(
      mlsEvents.dealChanged,
      (payload, meta) =>
        mlsJobs.notifyDeal.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          createdMs: meta.createdAt.getTime(),
          change: payload,
        }),
      { name: 'mls.deals.notify' },
    ),
    // R2-04b: a removed deal document's object leaves the bucket
    subscribe(
      mlsEvents.dealDocumentRemoved,
      (payload, meta) =>
        mlsJobs.deleteDealDocumentObject.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          dealId: payload.dealId,
          documentId: payload.documentId,
        }),
      { name: 'mls.dealDocuments.deleteObject' },
    ),
  ];
}

export function unregisterMlsSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
