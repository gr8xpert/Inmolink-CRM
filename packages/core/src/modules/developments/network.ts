/**
 * The new-build side of network search (S5-05, PLAN §3 #7, §7 M10): other agencies' units' commission terms for a
 * page of results — the unit's own commission, else its development's — read under the caller's RLS (a unit of a
 * development the caller may not see has no terms and is left out). Agent side only: never in Client Mode.
 */
import type { Tx } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { assertCan } from './policy';
import * as repo from './repo';

export interface NetworkUnitTerms {
  id: string;
  agencyId: string;
  priceCents: number | null;
  currency: string;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  /** The currency of `commissionFixedCents` (the unit's, or its development's when the development's applies). */
  commissionCurrency: string;
  commissionIncludesVat: boolean;
}

function assertAgentSide(ctx: Ctx): void {
  assertCan(ctx, 'development.read');
  if (ctx.clientMode) throw new AppError('FORBIDDEN');
}

/** These units of other agencies, as far as the caller may read them: one statement. */
export async function networkUnitTerms(ctx: Ctx, ids: readonly string[]): Promise<NetworkUnitTerms[]> {
  assertAgentSide(ctx);
  const rows = await repo.networkUnitTerms(ctx.tx, ctx.tenant.agencyId, ids);
  return rows.map((r) => {
    const own = r.unitCommissionBp !== null || r.unitCommissionFixedCents !== null;
    return {
      id: r.id,
      agencyId: r.agencyId,
      priceCents: r.priceCents,
      currency: r.currency,
      commissionBp: own ? r.unitCommissionBp : r.developmentCommissionBp,
      commissionFixedCents: own ? r.unitCommissionFixedCents : r.developmentCommissionFixedCents,
      commissionCurrency: own ? r.currency : r.developmentCurrency,
      commissionIncludesVat: own ? r.unitCommissionIncludesVat : r.developmentCommissionIncludesVat,
    };
  });
}

/**
 * S10-02 (CRM leads, raw `tx` of the caller's agency): the developer agency of a development or unit a lead is about,
 * or null when the caller cannot read it (RLS) or it is deleted.
 */
export function leadTargetOwner(tx: Tx, kind: 'DEVELOPMENT' | 'UNIT', id: string): Promise<string | null> {
  return repo.leadTargetOwner(tx, kind, id);
}
