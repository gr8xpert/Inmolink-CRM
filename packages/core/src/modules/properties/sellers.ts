import { withTenant } from '@inmolink/db';
import { emit } from '@inmolink/platform/outbox';
import { propertiesEvents } from './events';
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
 * `crm.contact.erased`. Idempotent: a redelivery finds nothing left to clear. Under the agency's RLS. S16-04 review:
 * each cleared listing emits `properties.listing.updated` (`changed: ['seller']`) in the same transaction, so its read
 * models and search document are rebuilt from the erased state. S16-F5: all of them in one `emit` statement.
 */
export async function clearSellerContact(p: {
  agencyId: string;
  contactIds: readonly string[];
}): Promise<{ rows: number }> {
  const rows = await withTenant({ agencyId: p.agencyId }, async (tx) => {
    const cleared = await repo.clearSeller(tx, p.agencyId, p.contactIds);
    // S16-F5: one statement for every cleared listing's event (`emit` takes a batch)
    await emit(
      tx,
      cleared.map((l) =>
        propertiesEvents.updated({
          listingId: l.listingId,
          agencyId: p.agencyId,
          version: l.version,
          changed: ['seller'],
        }),
      ),
    );
    return cleared.length;
  });
  return { rows };
}

/** S16-04 review, retention: which of these contacts sell a listing of the agency that is still on the market. */
export async function activeSellerContacts(p: {
  agencyId: string;
  contactIds: readonly string[];
}): Promise<Set<string>> {
  return withTenant({ agencyId: p.agencyId }, (tx) => repo.activeSellers(tx, p.agencyId, p.contactIds));
}
