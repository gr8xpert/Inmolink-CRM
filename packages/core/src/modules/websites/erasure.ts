import { withTenant } from '@inmolink/db';
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
