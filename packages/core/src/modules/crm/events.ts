import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * crm events (PATTERNS §8), emitted in the transaction of the change. IDs only — never names, e-mails or phones.
 *
 * - `crm.contact.created` — a contact was created (form, import, later inbound leads).
 * - `crm.contact.updated` — a contact's details changed (a merge into it included).
 * - `crm.contact.merged` — `mergedId` was merged into `survivorId` and closed. CRM tables that point at a contact
 *   are re-pointed in the merge's own transaction (`repo.CONTACT_REFERENCES`: notes, leads S10-02, activities
 *   S10-04; tasks S10-05 add theirs there). **Other modules that keep a contact id react to this event** and move
 *   their rows to `survivorId` — client registrations (S12); `property_privates.seller_contact_id` (S10-07) follows through crm's own
 *   `crm.repointSellerListings` job (properties never imports crm).
 *   Delivery is at least once: re-pointing `mergedId` → `survivorId` is idempotent by nature.
 * - `crm.contact.erased` (S11-F12) — the contact's personal data was erased (`eraseContact`): the row is a tombstone
 *   from then on (id, types, source, consent times, created / deleted times). crm's own rows that the request could
 *   bound were cleared in its transaction (identifiers, notes, facets, the leads' message and visitor details, task
 *   titles and descriptions, the seller prospects' titles, confidential notes and seller link, the calendar events it
 *   attends); the subscription queues `crm.eraseContactData` for the rest — activity bodies (batched), the inbound
 *   website leads (`websites.eraseInboundLeads`) and `property_privates.seller_contact_id` (properties'
 *   `clearSellerContact`; neither module imports crm). Delivery is at least once: every step is idempotent.
 * - `crm.import.requested` — a contact import was started; the subscription queues `crm.importContacts`.
 * - `crm.lead.created` (S10-02) — a lead reached the holder's inbox (`inboundLeadId`: promoted from a website lead;
 *   `assignedUserId`: the member the routing rule or the creator chose). website-api notifies the agency from it — the
 *   assigned agent, else the site contact or the admins. S12-F2: crm raises `LEAD_ASSIGNED` to the assignee from it
 *   (`assignedBy`: who entered it, left out of the notification).
 * - `crm.lead.updated` (S10-02) — a lead's assignment changed; `version` is the new one (since S10-03 a status change
 *   is a stage change: `crm.lead.stageChanged`). S12-F2: `LEAD_ASSIGNED` to the new assignee (`assignedBy`: who).
 * - `crm.lead.stageChanged` (S10-03) — a lead moved to another pipeline stage (a drag on the board, or a status set);
 *   `status` is the new stage's. The move's history row is already written (`lead_stage_history`); the activity
 *   timeline records `STAGE_CHANGED` from it.
 * - `crm.lead.responded` (S11-F10) — a logged e-mail, call or meeting became the lead's first human response
 *   (`receivedMs`: the lead's `created_ms`); a status / stage change that is one rides on `crm.lead.stageChanged`.
 *   crm rebuilds the response-KPI rollup of that day from it (`report-rollups.ts`); `crm.lead.created` and
 *   `crm.lead.stageChanged` carry `receivedMs` for the same reason and also rebuild the leads-per-stage rollup.
 * - `crm.calendarEvent.reminderDue` (S10-06) — the reminder sweep claimed a calendar event's remind time (`remindMs`,
 *   epoch ms); one event per member attendee (`userId`); the subscription queues `crm.sendEventReminder`. Written in the
 *   claiming transaction.
 * - `crm.task.reminderDue` (S10-05) — the reminder sweep claimed a task that came due (`dueMs`: the due time it claimed, `remindedMs`: when, both
 *   epoch ms); the subscription queues `crm.sendTaskReminder`. Written in the claiming transaction.
 */
export const crmEvents = {
  contactCreated: defineEvent(
    'crm.contact.created',
    1,
    z.object({ agencyId: z.uuid(), contactId: z.uuid(), source: z.string() }),
  ),
  contactUpdated: defineEvent(
    'crm.contact.updated',
    1,
    z.object({ agencyId: z.uuid(), contactId: z.uuid(), version: z.number().int() }),
  ),
  contactMerged: defineEvent(
    'crm.contact.merged',
    1,
    z.object({ agencyId: z.uuid(), survivorId: z.uuid(), mergedId: z.uuid() }),
  ),
  contactErased: defineEvent('crm.contact.erased', 1, z.object({ agencyId: z.uuid(), contactId: z.uuid() })),
  importRequested: defineEvent('crm.import.requested', 1, z.object({ agencyId: z.uuid(), importId: z.uuid() })),
  leadCreated: defineEvent(
    'crm.lead.created',
    1,
    z.object({
      agencyId: z.uuid(),
      leadId: z.uuid(),
      source: z.string(),
      inboundLeadId: z.uuid().nullable(),
      assignedUserId: z.uuid().nullable(),
      /** S12-F2: the member who entered the lead by hand (null: a channel delivered it). Absent in older events. */
      assignedBy: z.uuid().nullable().optional(),
      /** S11-F10: the lead's `created_ms` (epoch ms) — the day of the response-KPI rollup. Absent in older events. */
      receivedMs: z.number().int().optional(),
    }),
  ),
  leadUpdated: defineEvent(
    'crm.lead.updated',
    1,
    z.object({
      agencyId: z.uuid(),
      leadId: z.uuid(),
      version: z.number().int(),
      status: z.string(),
      assignedUserId: z.uuid().nullable(),
      /** S12-F2: the member who changed the assignment. Absent in older events. */
      assignedBy: z.uuid().nullable().optional(),
    }),
  ),
  taskReminderDue: defineEvent(
    'crm.task.reminderDue',
    1,
    z.object({ agencyId: z.uuid(), taskId: z.uuid(), dueMs: z.number().int(), remindedMs: z.number().int() }),
  ),
  eventReminderDue: defineEvent(
    'crm.calendarEvent.reminderDue',
    1,
    z.object({ agencyId: z.uuid(), eventId: z.uuid(), userId: z.uuid(), remindMs: z.number().int() }),
  ),
  leadStageChanged: defineEvent(
    'crm.lead.stageChanged',
    1,
    z.object({
      agencyId: z.uuid(),
      leadId: z.uuid(),
      fromStageId: z.uuid(),
      toStageId: z.uuid(),
      status: z.string(),
      version: z.number().int(),
      /** S11-F10: the lead's `created_ms` (epoch ms) — the day of the response-KPI rollup. Absent in older events. */
      receivedMs: z.number().int().optional(),
      /** S11-F10: the move's time (epoch ms; the history row's `changed_at`). Absent in older events. */
      movedMs: z.number().int().optional(),
    }),
  ),
  leadResponded: defineEvent(
    'crm.lead.responded',
    1,
    z.object({ agencyId: z.uuid(), leadId: z.uuid(), receivedMs: z.number().int() }),
  ),
};
