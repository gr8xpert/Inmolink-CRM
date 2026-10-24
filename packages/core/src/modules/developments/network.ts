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

export interface NetworkDevelopmentTerms {
  id: string;
  agencyId: string;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  /** The currency of `commissionFixedCents` (the development's). */
  commissionCurrency: string;
  commissionIncludesVat: boolean;
}

/**
 * S11-02 (an MLS viewing request's terms snapshot): another agency's development's own commission terms, as far as the
 * caller may read it; null otherwise. Agent side only.
 */
export async function networkDevelopmentTerms(ctx: Ctx, id: string): Promise<NetworkDevelopmentTerms | null> {
  assertAgentSide(ctx);
  const row = await repo.networkDevelopmentTerms(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) return null;
  return {
    id: row.id,
    agencyId: row.agencyId,
    commissionBp: row.commissionBp,
    commissionFixedCents: row.commissionFixedCents,
    commissionCurrency: row.currency,
    commissionIncludesVat: row.commissionIncludesVat,
  };
}

/**
 * S10-02 (CRM leads, raw `tx` of the caller's agency): the developer agency of a development or unit a lead is about,
 * or null when the caller cannot read it (RLS) or it is deleted.
 */
export function leadTargetOwner(tx: Tx, kind: 'DEVELOPMENT' | 'UNIT', id: string): Promise<string | null> {
  return repo.leadTargetOwner(tx, kind, id);
}

/**
 * Reference and brand name of these developments for a list page (S12-F21), as far as the caller's RLS shows them (its
 * own, or one open to it): one statement, two columns.
 */
export async function developmentLabels(
  ctx: Ctx,
  ids: readonly string[],
): Promise<Map<string, { reference: string; title: string }>> {
  // The caller (mls) authorised the read itself; only Client Mode is refused here.
  if (ctx.clientMode) throw new AppError('FORBIDDEN');
  const rows = await repo.labels(ctx.tx, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, { reference: r.ref, title: r.name }]));
}
