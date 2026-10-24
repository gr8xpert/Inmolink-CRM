import { type EventMeta, subscribe } from '@inmolink/platform/outbox';
import * as properties from '../properties';
import * as websites from '../websites';
import { crmEvents } from './events';
import { crmJobs, queueReportDay, queueStageCounts } from './jobs';

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
    // S12-F2: the assignee's `LEAD_ASSIGNED` notification (a new lead with an assignee, a reassignment)
    subscribe(
      crmEvents.leadCreated,
      async (payload, meta) => {
        if (!payload.assignedUserId) return;
        await crmJobs.notifyLeadAssigned.enqueue({
          ...at(meta),
          leadId: payload.leadId,
          userId: payload.assignedUserId,
          assignedBy: payload.assignedBy ?? null,
          inbound: payload.inboundLeadId !== null,
        });
      },
      { name: 'crm.notify.leadCreated' },
    ),
    subscribe(
      crmEvents.leadUpdated,
      async (payload, meta) => {
        if (!payload.assignedUserId) return;
        await crmJobs.notifyLeadAssigned.enqueue({
          ...at(meta),
          leadId: payload.leadId,
          userId: payload.assignedUserId,
          assignedBy: payload.assignedBy ?? null,
          inbound: false,
        });
      },
      { name: 'crm.notify.leadUpdated' },
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
    // S10-07: listings whose seller was the closed contact follow the merge (properties never imports crm)
    subscribe(
      crmEvents.contactMerged,
      (payload, meta) =>
        crmJobs.repointSellerListings.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          survivorId: payload.survivorId,
          mergedId: payload.mergedId,
        }),
      { name: 'crm.prospects.sellerMerged' },
    ),
    // S11-F12: an erased contact's activity bodies and the listings naming it as seller (properties never imports crm)
    subscribe(
      crmEvents.contactErased,
      (payload, meta) =>
        crmJobs.eraseContactData.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          contactId: payload.contactId,
        }),
      { name: 'crm.contact.eraseData' },
    ),
    subscribe(
      crmEvents.taskReminderDue,
      (payload, meta) =>
        crmJobs.sendTaskReminder.enqueue({
          agencyId: meta.agencyId,
          taskId: payload.taskId,
          dueMs: payload.dueMs,
          remindedMs: payload.remindedMs,
        }),
      { name: 'crm.task.sendReminder' },
    ),
    subscribe(
      crmEvents.eventReminderDue,
      (payload, meta) =>
        crmJobs.sendEventReminder.enqueue({
          agencyId: meta.agencyId,
          eventId: payload.eventId,
          userId: payload.userId,
          remindMs: payload.remindMs,
        }),
      { name: 'crm.calendar.sendReminder' },
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
    // S11-F10: the report rollups follow the leads (throttled rebuilds; `receivedMs` absent in older events: the
    // event's own time, which is the lead's for a creation)
    subscribe(
      crmEvents.leadCreated,
      async (payload, meta) => {
        await queueStageCounts(meta.agencyId);
        // the lead's receipt (response KPI) is also its entry into the first stage (moves)
        await queueReportDay(meta.agencyId, payload.receivedMs ?? meta.createdAt.getTime());
      },
      { name: 'crm.reports.leadCreated' },
    ),
    subscribe(
      crmEvents.leadStageChanged,
      async (payload, meta) => {
        await queueStageCounts(meta.agencyId);
        // the move's day (moves) and, as a stage change can be the first response, the lead's receipt day (KPI)
        const at = [payload.movedMs ?? meta.createdAt.getTime()];
        if (payload.receivedMs !== undefined) at.push(payload.receivedMs);
        await queueReportDay(meta.agencyId, ...at);
      },
      { name: 'crm.reports.stageChanged' },
    ),
    subscribe(crmEvents.leadResponded, (payload, meta) => queueReportDay(meta.agencyId, payload.receivedMs), {
      name: 'crm.reports.leadResponded',
    }),
  ];
}

export function unregisterCrmSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
