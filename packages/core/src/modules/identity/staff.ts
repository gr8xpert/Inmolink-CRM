import type { Tx } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import * as compliance from '../compliance';
import * as repo from './repo';

/**
 * Inmolink staff (S1-03, ADR 0015). Staff are users without an agency whose role is in `staff_users`.
 * These take a raw `tx`: `withStaffCtx` builds `ctx` from `getStaffRole`, and the grant script runs
 * under `withSystem`.
 */
export type StaffRole = repo.StaffRole;
export const STAFF_ROLES = ['SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS'] as const satisfies readonly StaffRole[];

/** The caller's active staff role inside a `withStaff` transaction, or null. */
export async function getStaffRole(tx: Tx, userId: string): Promise<StaffRole | null> {
  return repo.findStaffRole(tx, userId);
}

/**
 * Grants a staff role to an existing, confirmed account (`pnpm staff:grant`, `withSystem`). A member of
 * an agency cannot be staff: one user has one tenant, and staff have none. Audited (S1-08).
 */
export async function grantStaff(tx: Tx, input: { email: string; role: StaffRole }): Promise<{ userId: string }> {
  const user = await repo.findUserIdByEmail(tx, input.email.trim().toLowerCase());
  if (user?.status !== 'ACTIVE') throw new AppError('NOT_FOUND', { entity: 'user' });
  if (await repo.hasMembership(tx, user.id)) throw new AppError('FORBIDDEN', { reason: 'agency_member' });
  await repo.upsertStaff(tx, user.id, input.role);
  // Audit (S1-08): a platform row in the same transaction; the reason text stays in the withSystem log.
  await compliance.auditSystem(tx, {
    type: 'identity.staff.granted',
    agencyId: null,
    target: { type: 'user', id: user.id },
    metadata: { role: input.role, reasonProvided: true },
  });
  return { userId: user.id };
}

/** Withdraws staff access (`pnpm staff:revoke`); effective on the staff member's next request. Audited (S1-08). */
export async function revokeStaff(tx: Tx, input: { email: string }): Promise<boolean> {
  const user = await repo.findUserIdByEmail(tx, input.email.trim().toLowerCase());
  if (!user || !(await repo.deactivateStaff(tx, user.id, clock.now()))) return false;
  await compliance.auditSystem(tx, {
    type: 'identity.staff.revoked',
    agencyId: null,
    target: { type: 'user', id: user.id },
    metadata: { reasonProvided: true },
  });
  return true;
}

/** Active admins of an agency (email, name, UI locale), for notices sent by jobs (`withSystem`). */
export async function listAgencyAdmins(tx: Tx, agencyId: string) {
  return repo.listAdminRecipients(tx, agencyId);
}
