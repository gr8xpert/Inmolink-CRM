import type { Tx } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import * as properties from '../properties';

/**
 * The listing a CRM body points at (a lead's target, a task's, event's or activity's listing), as the caller's RLS shows
 * it. Unknown, deleted or not visible: `LEAD_TARGET_NOT_FOUND` (422: the body is wrong, not the URL). `ownOnly`: the
 * listing must be the agency's own (tasks, events and activities are about its listings, never a network one).
 */
export async function linkedListing(tx: Tx, agencyId: string, listingId: string, opts: { ownOnly?: boolean } = {}) {
  const listing = await properties.leadTargetListing(tx, agencyId, listingId);
  if (!listing || (opts.ownOnly && listing.agencyId !== agencyId)) throw new AppError('LEAD_TARGET_NOT_FOUND');
  return listing;
}
