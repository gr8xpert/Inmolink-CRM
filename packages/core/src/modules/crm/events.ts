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
 *   their rows to `survivorId` — client registrations (S12) and `property_privates.seller_contact_id` (S10-07).
 *   Delivery is at least once: re-pointing `mergedId` → `survivorId` is idempotent by nature.
 * - `crm.import.requested` — a contact import was started; the subscription queues `crm.importContacts`.
 * - `crm.lead.created` (S10-02) — a lead reached the holder's inbox (`inboundLeadId`: promoted from a website lead;
 *   `assignedUserId`: the member the routing rule or the creator chose). website-api notifies the agency from it — the
 *   assigned agent, else the site contact or the admins.
 * - `crm.lead.updated` (S10-02) — a lead's status or assignment changed; `version` is the new one.
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
    }),
  ),
};
