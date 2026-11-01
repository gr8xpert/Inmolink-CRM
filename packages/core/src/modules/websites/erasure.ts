import { type Tx, withTenant } from '@inmolink/db';
import { websiteLeads } from '@inmolink/db/schema/websites';
import { and, asc, eq, inArray } from 'drizzle-orm';
import * as repo from './leads-repo';

/**
 * A crm contact erasure (S11-F12): the inbound website leads the erased contact's crm leads were promoted from
 * (`leads.inbound_lead_id`) lose the visitor's details (`leadsRepo.eraseLeads`). Called by crm's `crm.eraseContactData`
 * job for `crm.contact.erased`, a batch of ids at a time (websites never imports crm: crm already imports websites).
 * Idempotent: a rerun clears nothing more. Under the agency's RLS — a website lead belongs to the presenting agency,
 * the one whose inbox it was promoted into.
 */
export async function eraseInboundLeads(p: { agencyId: string; ids: readonly string[] }): Promise<{ rows: number }> {
  if (p.ids.length === 0) return { rows: 0 };
  const rows = await withTenant({ agencyId: p.agencyId }, (tx) => repo.eraseLeads(tx, p.agencyId, p.ids));
  return { rows };
}

/** Website leads per call of the agency erasure. */
const AGENCY_BATCH = 500;

/**
 * S16-04 review, agency erasure: one batch of the agency's website leads — promoted or not (a lead that never reached
 * the inbox still holds the visitor's details) — lose the visitor's details. `more`: call again.
 */
export async function eraseAgencyLeads(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  return withTenant({ agencyId: p.agencyId }, async (tx) => {
    const ids = await repo.unerasedLeadIds(tx, p.agencyId, AGENCY_BATCH);
    const rows = await repo.eraseLeads(tx, p.agencyId, ids);
    return { rows, more: ids.length === AGENCY_BATCH };
  });
}

/**
 * S16-F5, the `SUBJECT` data export: these website enquiries (ids of the subject's crm leads' `inbound_lead_id`) with
 * what the visitor sent — name, e-mail, phone, message, kind, locale, the viewing slots asked for, their marketing
 * consent and when. Not the page URL's query, the key tier or the hashes (technical). Under the caller's RLS (`tx`).
 */
export async function subjectInboundLeads(tx: Tx, agencyId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: websiteLeads.id,
      kind: websiteLeads.kind,
      locale: websiteLeads.locale,
      name: websiteLeads.name,
      email: websiteLeads.email,
      phone: websiteLeads.phone,
      message: websiteLeads.message,
      viewingSlots: websiteLeads.viewingSlots,
      marketingConsent: websiteLeads.marketingConsent,
      createdAt: websiteLeads.createdAt,
    })
    .from(websiteLeads)
    .where(and(eq(websiteLeads.agencyId, agencyId), inArray(websiteLeads.id, [...ids])))
    .orderBy(asc(websiteLeads.id));
}
