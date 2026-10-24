import { withTenant } from '@inmolink/db';
import * as repo from './repo';

/**
 * A crm contact merge (S10-07): the agency's listings whose seller was the closed contact name the survivor instead.
 * Called by crm's job for `crm.contact.merged` (crm owns the event and resolves the final open contact; properties
 * never imports crm). Idempotent: a redelivered merge finds nothing left to move. Under the agency's RLS.
 */
export async function repointSellerContact(p: {
  agencyId: string;
  fromContactId: string;
  toContactId: string;
}): Promise<{ rows: number }> {
  const rows = await withTenant({ agencyId: p.agencyId }, (tx) =>
    repo.repointSeller(tx, p.agencyId, p.fromContactId, p.toContactId),
  );
  return { rows };
}

/**
 * A crm contact erasure (S11-F12): the agency's listings whose seller was the erased contact (or a contact merged into it) name no seller (the
 * listing itself, its owner-side data and its history stay). Called by crm's `crm.eraseContactData` job for
 * `crm.contact.erased`. Idempotent: a redelivery finds nothing left to clear. Under the agency's RLS.
 */
export async function clearSellerContact(p: {
  agencyId: string;
  contactIds: readonly string[];
}): Promise<{ rows: number }> {
  const rows = await withTenant({ agencyId: p.agencyId }, (tx) => repo.clearSeller(tx, p.agencyId, p.contactIds));
  return { rows };
}
