/**
 * The listing side of portal selection (S9-01, PATTERNS §12 "Cross-module functions for workers"): raw `tx`, no
 * authorization (the exports service authorizes), ids and references only. A listing is exportable when it is the
 * agency's own, ACTIVE, PUBLIC and not deleted — a portal never gets a PRIVATE or SHARED listing, whatever a
 * connection's rule or per-property choice says.
 */
import type { Tx } from '@inmolink/db';
import * as repo from './export-repo';

/** The agency's exportable listing ids after `after`, ascending, at most `limit`; `tag`: only those carrying it. */
export const exportableListingPage = (
  tx: Tx,
  agencyId: string,
  q: { tag: string | null; after: string | null; limit: number },
) => repo.exportableIdPage(tx, agencyId, q);

/**
 * `exportableListingPage` and `exportableListingIds` in one statement (S10-F9): the page, and of `ids` the exportable
 * ones.
 */
export const exportableListingPageWith = (
  tx: Tx,
  agencyId: string,
  q: { tag: string | null; after: string | null; limit: number },
  ids: readonly string[],
) => repo.exportableIdPageWith(tx, agencyId, q, ids);

/** Of these listing ids (a page's worth), the agency's exportable ones. */
export const exportableListingIds = (tx: Tx, agencyId: string, ids: readonly string[]) =>
  repo.exportableIds(tx, agencyId, ids);

/** Of these listing ids, the agency's own that exist and are not deleted (per-property choices may name them). */
export const ownListingIds = (tx: Tx, agencyId: string, ids: readonly string[]) => repo.ownLiveIds(tx, agencyId, ids);

/** The references of the agency's listings among these ids. */
export const listingRefs = (tx: Tx, agencyId: string, ids: readonly string[]) => repo.refsOf(tx, agencyId, ids);

/** The agency's not deleted listings with these references (case-insensitive), one statement: `{ id, ref }` of each found. */
export const listingIdsByRefs = (tx: Tx, agencyId: string, refs: readonly string[]) =>
  repo.idsByRefs(tx, agencyId, refs);
