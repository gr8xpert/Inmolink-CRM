/**
 * S12-F21: what the collaborations lists show for a target — reference and title — for a whole page at once. Listings
 * come from the listing read models (one statement), developments from their two columns (one statement); never a
 * join per row. A target the caller can no longer read (left the network, deleted) has no label.
 */
import type { RegistrationTarget, TargetLabel } from '@inmolink/contracts';
import type { Ctx } from '../../context';
import * as developments from '../developments';
import * as search from '../search';

export type TargetLabels = Map<string, TargetLabel>;

export async function targetLabels(ctx: Ctx, targets: readonly RegistrationTarget[]): Promise<TargetLabels> {
  const ids = (kind: RegistrationTarget['kind']) => targets.filter((t) => t.kind === kind).map((t) => t.id);
  const out: TargetLabels = new Map();
  const listingIds = ids('LISTING');
  const developmentIds = ids('DEVELOPMENT');
  // One after the other: a transaction runs one statement at a time.
  if (listingIds.length > 0) {
    for (const [id, l] of await search.listingLabels(ctx.tx, listingIds, ctx.locale)) out.set(id, l);
  }
  if (developmentIds.length > 0) {
    for (const [id, l] of await developments.developmentLabels(ctx, developmentIds)) out.set(id, l);
  }
  return out;
}
