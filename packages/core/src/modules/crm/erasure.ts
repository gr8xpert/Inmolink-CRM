import { AppError, type EraseContactBody } from '@inmolink/contracts';
import { withTenant } from '@inmolink/db';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import * as compliance from '../compliance';
import * as properties from '../properties';
import * as websites from '../websites';
import * as activitiesRepo from './activities-repo';
import { crmEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * Contact erasure (S11-F12, a data subject's "right to be forgotten", GDPR Art. 17; the full flow with search and
 * read-model scans is S16's). The contact becomes a tombstone and every free text the agency holds about it goes:
 *
 * - **In the request's transaction** (`repo.eraseContact`, one statement): names, primary e-mail / phone, language and
 *   tags cleared, consents off, do-not-contact on, the row closed (`deleted_at`; `merged_into_id` stays null — that is
 *   how readers tell an erased contact from a merged one); its e-mails, phones, facets and notes deleted; its leads'
 *   message, visitor details and replay hashes, its tasks' titles (`repo.ERASED_TITLE`) and descriptions, its seller
 *   prospects' titles, confidential notes and seller link cleared; calendar events it attends get a new version (the
 *   ICS feed's fingerprint changes), and those where no other contact attends lose title, description and location.
 *   Closed contacts merged into it earlier lose their names too.
 * - **After the commit** (`crm.contact.erased` → `crm.eraseContactData`): its activity bodies (its own and its leads',
 *   batches of 1,000); the inbound website leads its leads came from (`websites.eraseInboundLeads`, batches of 500);
 *   `property_privates.seller_contact_id` of it and of the contacts merged into it (`properties.clearSellerContact`;
 *   no cross-module FK). Then `crm.contact.erasureCompleted` is audited with the counts.
 *
 * **Kept** (no personal data): every id and timestamp — the tombstone (id, agency, types, source, owner, consent
 * times, created / deleted times), leads (stage, source, target, response KPI times), activities (type, time, subjects,
 * actor, `data`), tasks (due, status), calendar events with other contacts (their own title), attendances (an attendee
 * without a name is left out of feeds), prospects (address, stage, price — the property's), website leads (site, kind,
 * target, locale, slots, times) and the audit rows.
 *
 * Also kept, outside crm: mls client registrations (`details_enc`, the encrypted client snapshot) and viewing requests
 * that name the contact — the evidence of who introduced the client first (PLAN §3 #8), kept for the establishment or
 * defence of legal claims (GDPR Art. 17(3)(e)). S16's retention job deletes them after the registration's validity
 * plus the claim period. The target agency's receipts and its viewing-request copies are its own controller data.
 * Chat messages (S11-03) are the participants' correspondence: out of scope.
 *
 * After erasure no activity can be logged on the contact or its leads (`logActivity` checks the lead's contact is
 * open); the leads stay in the pipeline (ids and stages kept for the reports).
 *
 * Agency admins only (`crm.contacts.erase`), never impersonating staff; `confirm: 'ERASE'`. Audited
 * (`crm.contact.erased`, ids only).
 */
export async function eraseContact(ctx: Ctx, contactId: string, input: EraseContactBody): Promise<void> {
  assertCan(ctx, 'crm.contacts.erase');
  const [contact] = await repo.lockAndLoad(ctx.tx, [contactId]);
  if (!contact) throw new AppError('CONTACT_NOT_FOUND');
  assertCan(ctx, 'crm.contacts.erase', contact);
  if (contact.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const agencyId = ctx.tenant.agencyId;
  await repo.eraseContact(ctx.tx, agencyId, contactId);
  await compliance.audit(ctx, 'crm.contact.erased', { type: 'contact', id: contactId });
  await emit(ctx.tx, crmEvents.contactErased({ agencyId, contactId }));
}

/** Activity rows per statement when an erased contact's bodies are cleared. */
const ERASE_BATCH = 1_000;
/** Inbound website leads per call when an erased contact's are cleared. */
const INBOUND_BATCH = 500;

export interface ErasureCounts {
  activities: number;
  inboundLeads: number;
  listings: number;
}

/**
 * `crm.eraseContactData` (after `crm.contact.erased`): the erased contact's (and its leads') activity bodies, in batches
 * of 1,000, a transaction each; the inbound website leads its leads came from, 500 at a time; then the listings that
 * named it (or a contact merged into it) as seller name none; last, `crm.contact.erasureCompleted` is audited with the
 * counts. Idempotent: a rerun finds nothing left (its audit row says 0, 0, 0). Under the agency's RLS: another agency's
 * id finds nothing.
 */
export async function eraseContactData(p: { agencyId: string; contactId: string }): Promise<ErasureCounts> {
  const tenant = { agencyId: p.agencyId };
  let activities = 0;
  for (;;) {
    const n = await withTenant(tenant, (tx) =>
      activitiesRepo.clearContactBodies(tx, p.agencyId, p.contactId, ERASE_BATCH),
    );
    activities += n;
    if (n < ERASE_BATCH) break;
  }
  let inboundLeads = 0;
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const ids: string[] = await withTenant(tenant, (tx) =>
      repo.inboundLeadsOf(tx, p.agencyId, p.contactId, cursor, INBOUND_BATCH),
    );
    inboundLeads += (await websites.eraseInboundLeads({ agencyId: p.agencyId, ids })).rows;
    if (ids.length < INBOUND_BATCH) break;
    after = ids[ids.length - 1] ?? null;
  }
  const merged = await withTenant(tenant, (tx) => repo.mergedInto(tx, p.agencyId, p.contactId));
  const { rows: listings } = await properties.clearSellerContact({
    agencyId: p.agencyId,
    contactIds: [p.contactId, ...merged],
  });
  const counts = { activities, inboundLeads, listings };
  await withTenant(tenant, (tx) =>
    compliance.auditSystem(tx, {
      type: 'crm.contact.erasureCompleted',
      agencyId: p.agencyId,
      target: { type: 'contact', id: p.contactId },
      metadata: { ...counts },
    }),
  );
  return counts;
}
