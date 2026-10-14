import type { TenantDetailDto, TenantListQuery, TenantPage } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { StaffCtx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as compliance from '../compliance';
import { assertStaffCan } from './policy';
import * as repo from './repo';
import * as tenantsRepo from './tenants-repo';

/**
 * Staff console: tenants (S1-09, PLAN §7 M20). Every staff role reads them (`staff.tenants.read`); what
 * staff may change about an agency stays with the use cases that own it (verification decides status).
 */

/** `GET /v1/staff/agencies`: newest first, keyset; filter by status, search by name or tax id. */
export async function listTenants(ctx: StaffCtx, q: TenantListQuery): Promise<TenantPage> {
  assertStaffCan(ctx, 'staff.tenants.read');
  const rows = await tenantsRepo.listTenants(ctx.tx, {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
    status: q.status,
    search: q.q,
  });
  return toPage(
    rows,
    q.limit,
    (r) => ({ at: r.createdAt, id: r.id }),
    (r) => ({ ...r, createdAt: r.createdAt.toISOString() }),
  );
}

/** Name and status for other staff use cases (impersonation); not audited — the caller audits its own action. */
export async function getTenantSummary(
  ctx: StaffCtx,
  input: { agencyId: string },
): Promise<{ id: string; name: string; status: tenantsRepo.AgencyStatus }> {
  assertStaffCan(ctx, 'staff.tenants.read');
  const row = await tenantsRepo.getTenant(ctx.tx, input.agencyId);
  if (!row) throw new AppError('NOT_FOUND', { entity: 'agency' });
  return { id: row.id, name: row.name, status: row.status };
}

/**
 * `GET /v1/staff/agencies/:agencyId`: company details and the latest verification request. The read is
 * audited under the agency (`staff.tenant.read`, PLAN §12 "all staff actions audited").
 */
export async function getTenant(ctx: StaffCtx, input: { agencyId: string }): Promise<TenantDetailDto> {
  assertStaffCan(ctx, 'staff.tenants.read');
  const row = await tenantsRepo.getTenant(ctx.tx, input.agencyId);
  if (!row) throw new AppError('NOT_FOUND', { entity: 'agency' });
  const request = await repo.getLatestRequest(ctx.tx, input.agencyId);
  await compliance.auditStaff(ctx, input.agencyId, 'staff.tenant.read', { type: 'agency', id: input.agencyId });
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    verification: request
      ? {
          requestId: request.id,
          status: request.status,
          submittedAt: request.submittedAt.toISOString(),
          decidedAt: request.decidedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/**
 * Names of the agencies on a page of staff-facing records (the audit viewer), one query. Not audited:
 * the caller's own read is.
 */
export async function agencyNames(ctx: StaffCtx, ids: readonly string[]): Promise<Map<string, string>> {
  assertStaffCan(ctx, 'staff.tenants.read');
  const rows = await tenantsRepo.agencyNames(ctx.tx, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, r.name]));
}
