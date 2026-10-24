import type { SetGiveToGetExemptionBody, TenantDetailDto } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';
import * as compliance from '../compliance';
import { assertCan, assertStaffCan } from './policy';
import * as repo from './preferred-repo';
import { getTenant } from './tenants';
import * as tenantsRepo from './tenants-repo';

/**
 * The agency as network search sees it (S5-05, PLAN §3 #5 #57): its give-to-get standing (sign-up date, staff
 * exemption) and its own preferred list (the "preferred agencies only" filter). Staff set the exemption for
 * buyer-only agencies.
 */

export interface NetworkStanding {
  createdAt: Date;
  giveToGetExempt: boolean;
  preferred: string[];
}

/**
 * The caller's agency: one query. Members only, never in Client Mode. The owners preferring the caller are not part
 * of it (S6-F2): PREFERRED listings' index documents name the agencies their owner prefers, so network search filters
 * on the caller alone, however many owners prefer it.
 */
export async function getNetworkStanding(ctx: Ctx): Promise<NetworkStanding> {
  assertCan(ctx, 'agencies.network.read');
  const row = await repo.networkStanding(ctx.tx, ctx.tenant.agencyId);
  if (!row) throw new AppError('NOT_FOUND', { entity: 'agency' });
  return row;
}

/** Directory names of the owners on a page of network results (one query); unknown ids are absent. */
export async function networkAgencyNames(ctx: Ctx, ids: readonly string[]): Promise<Map<string, string>> {
  assertCan(ctx, 'agencies.network.read');
  const rows = await repo.directoryNames(ctx.tx, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Worker form of `networkAgencyNames` (PATTERNS §12): directory names in a job's own transaction (S11-02: the
 * counterpart agency named in a viewing request's notification). One query; unknown ids are absent.
 */
export async function directoryNamesOf(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await repo.directoryNames(tx, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * `PUT /v1/staff/agencies/:agencyId/give-to-get`: support exempts a buyer-only agency, or ends it, with a reason (S6-F1:
 * kept on the agency, shown on its staff page). Audited with the exemption before and after — the reason is free text,
 * so it stays out of the audit metadata (`AuditMetadata`).
 */
export async function setGiveToGetExemption(
  ctx: StaffCtx,
  input: SetGiveToGetExemptionBody & { agencyId: string },
): Promise<TenantDetailDto> {
  assertStaffCan(ctx, 'staff.giveToGet.manage');
  const changed = await tenantsRepo.setGiveToGetExempt(
    ctx.tx,
    input.agencyId,
    { exempt: input.exempt, reason: input.reason },
    clock.now(),
  );
  if (!changed) throw new AppError('NOT_FOUND', { entity: 'agency' });
  await compliance.auditStaff(
    ctx,
    input.agencyId,
    'agencies.giveToGet.changed',
    { type: 'agency', id: input.agencyId },
    { before: changed.before, after: input.exempt },
  );
  return getTenant(ctx, { agencyId: input.agencyId });
}
