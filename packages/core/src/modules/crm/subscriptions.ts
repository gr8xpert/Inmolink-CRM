import { type EventMeta, subscribe } from '@inmolink/platform/outbox';
import * as properties from '../properties';
import * as websites from '../websites';
import { crmEvents } from './events';
import { crmJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/** The event's identity and time: the activity's (the tenant is `meta.agencyId`, RLS-checked at emit). */
const at = (meta: EventMeta) => ({
  eventId: meta.eventId,
  agencyId: meta.agencyId,
  occurredAt: meta.createdAt.toISOString(),
});

/**
 * Outbox → crm worker. Each `crm.import.requested` event becomes one `crm.importContacts` job (job ID = the import's
 * id: a redelivered event adds nothing). The tenant is `meta.agencyId` (RLS-checked when the event was written), the
 * fair-share group. Each `websites.lead.received` event (S10-02) becomes one `crm.promoteInboundLead` job (job ID = the
 * inbound lead's id). Called once by the worker.
 *
 * S10-04, the activity timeline: `crm.lead.created`, `crm.lead.updated`, `crm.contact.merged` and
 * `properties.listing.statusChanged` each become one `crm.recordActivity` job (job ID = the event's id), with the
 * event's time. Website leads appear once promoted (`crm.lead.created`), not as `websites.lead.received` too. Left out
 * on purpose: contact created / updated (the contact shows its own dates; imports would flood the queue), listing
 * edits and feed imports (volume; the listing's history is S13's), notes (written in the note's transaction).
 * `crm.lead.updated` is only emitted for an assignee change (a merge re-points leads without it), so every one is a
 * real `LEAD_UPDATED`; a stage change (a drag, a status set) is `crm.lead.stageChanged` → `STAGE_CHANGED` (S10-03). A purged listing (`properties.listing.purged`) leaves the timelines
 * (`crm.forgetListingActivities`).
 */
export function registerCrmSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      crmEvents.importRequested,
      (payload, meta) => crmJobs.importContacts.enqueue({ agencyId: meta.agencyId, importId: payload.importId }),
      { name: 'crm.import.start' },
    ),
    subscribe(
      websites.websitesEvents.leadReceived,
      (payload, meta) => crmJobs.promoteInboundLead.enqueue({ agencyId: meta.agencyId, inboundLeadId: payload.leadId }),
      { name: 'crm.lead.promote' },
    ),
    subscribe(
      crmEvents.leadCreated,
      (payload, meta) =>
        crmJobs.recordActivity.enqueue({
          ...at(meta),
          type: 'LEAD_CREATED',
          leadId: payload.leadId,
          data: { source: payload.source, assignedUserId: payload.assignedUserId },
        }),
      { name: 'crm.activity.leadCreated' },
    ),
    subscribe(
      crmEvents.leadUpdated,
      (payload, meta) =>
        crmJobs.recordActivity.enqueue({
          ...at(meta),
          type: 'LEAD_UPDATED',
          leadId: payload.leadId,
          data: { status: payload.status, assignedUserId: payload.assignedUserId, version: payload.version },
        }),
      { name: 'crm.activity.leadUpdated' },
    ),
    subscribe(
      crmEvents.leadStageChanged,
      (payload, meta) =>
        crmJobs.recordActivity.enqueue({
          ...at(meta),
          type: 'STAGE_CHANGED',
          leadId: payload.leadId,
          data: {
            fromStageId: payload.fromStageId,
            toStageId: payload.toStageId,
            status: payload.status,
            version: payload.version,
          },
        }),
      { name: 'crm.activity.stageChanged' },
    ),
    subscribe(
      crmEvents.contactMerged,
      (payload, meta) =>
        crmJobs.recordActivity.enqueue({
          ...at(meta),
          type: 'CONTACT_MERGED',
          contactId: payload.survivorId,
          data: { mergedId: payload.mergedId },
        }),
      { name: 'crm.activity.contactMerged' },
    ),
    subscribe(
      properties.propertiesEvents.statusChanged,
      (payload, meta) =>
        crmJobs.recordActivity.enqueue({
          ...at(meta),
          type: 'LISTING_STATUS_CHANGED',
          listingId: payload.listingId,
          data: { from: payload.from, to: payload.to },
        }),
      { name: 'crm.activity.listingStatus' },
    ),
    subscribe(
      properties.propertiesEvents.purged,
      (payload, meta) =>
        crmJobs.forgetListingActivities.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          listingId: payload.listingId,
        }),
      { name: 'crm.activity.listingPurged' },
    ),
  ];
}

export function unregisterCrmSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
