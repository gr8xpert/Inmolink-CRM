import type { SetGiveToGetExemptionBody, TenantDetailDto } from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import type { Ctx, StaffCtx } from '../../context';
import * as compliance from '../compliance';
import { assertCan, assertStaffCan } from './policy';
import * as repo from './preferred-repo';
import { getTenant } from './tenants';
import * as tenantsRepo from './tenants-repo';

/**
 * The agency as network search sees it (S5-05, PLAN §3 #5 #57): its give-to-get standing (sign-up date, staff
 * exemption) and its partners — the agencies that prefer it (their PREFERRED listings reach it) and its own
 * preferred list (the "preferred agencies only" filter). Staff set the exemption for buyer-only agencies.
 */

/**
 * Most preferring agencies network search filters by. Past it, the PREFERRED listings of the owners left out are not
 * found (RLS would still allow them): logged, so the cap can be raised or the filter redesigned before it matters
 * (5,000 agencies in all, PLAN §1).
 */
export const NETWORK_PREFERRING_CAP = 2_000;

let log: Logger | undefined;
const logger = () => {
  log ??= createLogger({ service: 'agencies' });
  return log;
};

export interface NetworkStanding {
  createdAt: Date;
  giveToGetExempt: boolean;
  preferring: string[];
  preferred: string[];
}

/** The caller's agency: one query. Members only, never in Client Mode. */
export async function getNetworkStanding(ctx: Ctx): Promise<NetworkStanding> {
  assertCan(ctx, 'agencies.network.read');
  const row = await repo.networkStanding(ctx.tx, ctx.tenant.agencyId, NETWORK_PREFERRING_CAP);
  if (!row) throw new AppError('NOT_FOUND', { entity: 'agency' });
  if (row.preferring.length >= NETWORK_PREFERRING_CAP) {
    logger().warn(
      { agencyId: ctx.tenant.agencyId, requestId: ctx.requestId, cap: NETWORK_PREFERRING_CAP },
      'network search: preferring agencies at the cap; some PREFERRED listings are not searched',
    );
  }
  return row;
}

/** Directory names of the owners on a page of network results (one query); unknown ids are absent. */
export async function networkAgencyNames(ctx: Ctx, ids: readonly string[]): Promise<Map<string, string>> {
  assertCan(ctx, 'agencies.network.read');
  const rows = await repo.directoryNames(ctx.tx, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** `PUT /v1/staff/agencies/:agencyId/give-to-get`: support exempts a buyer-only agency, or ends it; audited. */
export async function setGiveToGetExemption(
  ctx: StaffCtx,
  input: SetGiveToGetExemptionBody & { agencyId: string },
): Promise<TenantDetailDto> {
  assertStaffCan(ctx, 'staff.giveToGet.manage');
  const changed = await tenantsRepo.setGiveToGetExempt(ctx.tx, input.agencyId, input.exempt, clock.now());
  if (!changed) throw new AppError('NOT_FOUND', { entity: 'agency' });
  await compliance.auditStaff(
    ctx,
    input.agencyId,
    'agencies.giveToGet.changed',
    { type: 'agency', id: input.agencyId },
    { exempt: input.exempt },
  );
  return getTenant(ctx, { agencyId: input.agencyId });
}
