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
