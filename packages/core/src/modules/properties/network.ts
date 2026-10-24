/**
 * The listing side of network search (S5-05, PLAN §3 #5 #7): other agencies' listings' commission terms for a page of
 * results, read under the caller's RLS — the network predicate (share scope, preferred agencies, freshness) decides,
 * so a result the caller may not read has no terms and is left out — and the caller's give-to-get count. Agent side
 * only: never in Client Mode (commission, PLAN §3 #6).
 */
import type { Tx } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { assertCan } from './policy';
import * as repo from './repo';

export interface NetworkListingTerms {
  id: string;
  agencyId: string;
  priceCents: number | null;
  currency: string;
  priceOnRequest: boolean;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  splitBp: number | null;
  commissionIncludesVat: boolean;
}

function assertAgentSide(ctx: Ctx): void {
  assertCan(ctx, 'listing.read');
  if (ctx.clientMode) throw new AppError('FORBIDDEN');
}

/** These listings of other agencies, as far as the caller may read them: one primary-key probe each. */
export async function networkListingTerms(ctx: Ctx, ids: readonly string[]): Promise<NetworkListingTerms[]> {
  assertAgentSide(ctx);
  return repo.networkListingTerms(ctx.tx, ctx.tenant.agencyId, ids);
}

/**
 * The caller's ACTIVE listings on the network shared with every agency (SHARED or PUBLIC, scope ALL, not hidden for
 * freshness), counted up to `cap`.
 */
export async function countNetworkSharedListings(ctx: Ctx, cap: number): Promise<number> {
  assertAgentSide(ctx);
  return repo.countNetworkShared(ctx.tx, ctx.tenant.agencyId, cap);
}

/**
 * S10-02 (CRM leads, raw `tx` of the caller's agency, inbound promotion included): a listing as a lead's target — its
 * owner agency, and its responsible agent when the caller owns it (`OWNER_AGENT` assignment). Null when the caller
 * cannot read it (RLS) or it is deleted.
 */
export function leadTargetListing(tx: Tx, agencyId: string, id: string) {
  return repo.leadTargetListing(tx, agencyId, id);
}

/**
 * Worker form (PATTERNS §12, S11-05 network board matching): these listings' agency, reference and responsible agent,
 * in the job's `withSystem` transaction (one statement, ≤ the ids given). Never called from request code.
 */
export function listingAgentsOf(tx: Tx, ids: readonly string[]) {
  return repo.listingAgents(tx, ids);
}
