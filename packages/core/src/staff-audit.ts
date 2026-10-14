import type { StaffAuditPage, StaffAuditQuery } from '@inmolink/contracts';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import type { StaffCtx } from './context';
import * as agencies from './modules/agencies';
import * as compliance from './modules/compliance';
import * as identity from './modules/identity';

/**
 * `GET /v1/staff/audit-logs` with names (S1-F9): the audit page from compliance, then the agency and user
 * names of that page — one query each (agencies as `app_staff`, users as `app_auth`), never one per row.
 * Composed here because compliance cannot import identity or agencies (they audit through compliance).
 * Ids that no longer resolve (or platform rows, which have no agency) keep a null name.
 */
export async function listStaffAuditLog(ctx: StaffCtx, q: StaffAuditQuery): Promise<StaffAuditPage> {
  const page = await compliance.listAuditLogForStaff(ctx, q);
  const agencyIds = page.items.map((e) => e.agencyId).filter((id) => id !== PLATFORM_AGENCY_ID);
  const userIds = page.items.flatMap((e) => [
    e.actor.userId,
    e.actor.impersonatedBy,
    e.target?.type === 'user' ? e.target.id : null,
  ]);
  const [agencyNames, userNames] = await Promise.all([
    agencies.agencyNames(ctx, agencyIds),
    identity.userNames(
      ctx,
      userIds.filter((id): id is string => id !== null),
    ),
  ]);
  return {
    ...page,
    items: page.items.map((e) => ({
      ...e,
      agencyName: agencyNames.get(e.agencyId) ?? null,
      actor: {
        ...e.actor,
        userName: e.actor.userId ? (userNames.get(e.actor.userId) ?? null) : null,
        impersonatedByName: e.actor.impersonatedBy ? (userNames.get(e.actor.impersonatedBy) ?? null) : null,
      },
      target: e.target
        ? { ...e.target, name: e.target.type === 'user' ? (userNames.get(e.target.id) ?? null) : null }
        : null,
    })),
  };
}
