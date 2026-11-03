import { Email } from '@inmolink/contracts';
import { type Tx, withAuth } from '@inmolink/db';
import { DEFAULT_UI_LOCALE } from '@inmolink/i18n';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import * as compliance from '../compliance';
import { endImpersonationsOf } from './impersonation';
import { legacyPasswordPlaceholder } from './legacy';
import * as repo from './repo';

/**
 * Inmolink staff (S1-03, ADR 0015). Staff are users without an agency whose role is in `staff_users`.
 * These take a raw `tx`: `withStaffCtx` builds `ctx` from `getStaffRole`, and the grant script runs
 * under `withSystem`.
 */
export type StaffRole = repo.StaffRole;
export const STAFF_ROLES = ['SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS'] as const satisfies readonly StaffRole[];

/**
 * Whether the login identity is ACTIVE (S1-F7): staff access ends when `users.status` is not ACTIVE.
 * A short `app_auth` read (`app_staff` cannot see `users`), before the staff request's own transaction.
 */
export function isUserActive(userId: string): Promise<boolean> {
  return withAuth(async (tx) => (await repo.findUserForToken(tx, userId))?.status === 'ACTIVE');
}

/** The caller's active staff role inside a `withStaff` transaction, or null. */
export async function getStaffRole(tx: Tx, userId: string): Promise<StaffRole | null> {
  return repo.findStaffRole(tx, userId);
}

/**
 * Grants a staff role to an existing, active account (`pnpm staff:grant`, `withSystem`). A member of
 * an agency cannot be staff: one user has one tenant, and staff have none. Audited (S1-08).
 */
export async function grantStaff(tx: Tx, input: { email: string; role: StaffRole }): Promise<{ userId: string }> {
  const user = await repo.findUserIdByEmail(tx, input.email.trim().toLowerCase());
  if (user?.status !== 'ACTIVE') throw new AppError('NOT_FOUND', { entity: 'user' });
  if (await repo.hasMembership(tx, user.id)) throw new AppError('FORBIDDEN', { reason: 'agency_member' });
  await repo.upsertStaff(tx, user.id, input.role);
  // A role change ends any open impersonation (S1-09 review); the request check also re-reads the role.
  await endImpersonationsOf(tx, user.id);
  // Audit (S1-08): a platform row in the same transaction; the reason text stays in the withSystem log.
  await compliance.auditSystem(tx, {
    type: 'identity.staff.granted',
    agencyId: null,
    target: { type: 'user', id: user.id },
    metadata: { role: input.role, reasonProvided: true },
  });
  return { userId: user.id };
}

/** Display name of an account made by `bootstrapStaff`: the operator gives none, and it must not repeat the address. */
const BOOTSTRAP_STAFF_NAME = 'Inmolink staff';

export type StaffBootstrapOutcome = 'created' | 'granted' | 'unchanged';

/**
 * The first staff login of a fresh server (`pnpm staff:bootstrap`, `withSystem`; S17-F14): creates a confirmed account
 * with no agency and an unusable password when the address is free, then grants the role through `grantStaff`. A
 * created account gets its own audit row, because it was confirmed without proof of the inbox; the grant's row is the
 * same as ever. The person sets a password through Forgot password, which proves the inbox; no password or link passes
 * through here, and no confirmation email goes out. Staff must then enrol 2FA, as always (S1-04).
 *
 * The same role on the same active staff account again changes nothing and records nothing. Any other staff row is
 * refused: a re-run must not restore a revoked person or change a role, which is `pnpm staff:grant`'s job. Also refuses
 * a member of an agency (as `grantStaff`), a disabled account, and a never-confirmed one: its password was chosen by
 * whoever signed up with that address, so a role on it could hand staff access to them. There is no member acting, so no policy check; the operator
 * with database credentials is the authority, as for `grantStaff`. Hashes inside the transaction, only on a free
 * address, before it writes anything: a one-off command, and no caller can pass a hash in.
 */
export async function bootstrapStaff(
  tx: Tx,
  input: { email: string; role: StaffRole },
): Promise<{ userId: string; outcome: StaffBootstrapOutcome }> {
  if (!STAFF_ROLES.includes(input.role)) throw new AppError('VALIDATION_FAILED', { field: 'role' });
  const parsed = Email.safeParse(input.email);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', { field: 'email' });
  const email = parsed.data;
  let user = await repo.findSignupState(tx, email);
  let created = false;
  if (!user) {
    const inserted = await repo.insertUserIfAbsent(tx, {
      id: newId(),
      email,
      passwordHash: await legacyPasswordPlaceholder(),
      name: BOOTSTRAP_STAFF_NAME,
      locale: DEFAULT_UI_LOCALE,
      emailVerifiedAt: clock.now(),
    });
    created = inserted !== null;
    // A sign-up that won the race is read back, and refused like any other existing account.
    user = await repo.findSignupState(tx, email);
  }
  if (!user) throw new AppError('NOT_FOUND', { entity: 'user' });
  if (user.status !== 'ACTIVE') throw new AppError('FORBIDDEN', { reason: 'account_disabled' });
  if (await repo.hasMembership(tx, user.id)) throw new AppError('FORBIDDEN', { reason: 'agency_member' });
  if (!user.emailVerifiedAt) throw new AppError('FORBIDDEN', { reason: 'email_not_confirmed' });
  const staff = await repo.findStaffRecord(tx, user.id);
  if (staff) {
    if (staff.deactivatedAt) throw new AppError('FORBIDDEN', { reason: 'staff_revoked' });
    if (staff.role !== input.role) throw new AppError('FORBIDDEN', { reason: 'staff_role_differs' });
    return { userId: user.id, outcome: 'unchanged' };
  }
  if (created) {
    await compliance.auditSystem(tx, {
      type: 'identity.staff.accountCreated',
      agencyId: null,
      target: { type: 'user', id: user.id },
      metadata: { reasonProvided: true },
    });
  }
  await grantStaff(tx, { email, role: input.role });
  return { userId: user.id, outcome: created ? 'created' : 'granted' };
}

/**
 * Withdraws staff access (`pnpm staff:revoke`); effective on the staff member's next request, and their
 * open impersonation session ends with it (S1-09). Audited (S1-08).
 */
export async function revokeStaff(tx: Tx, input: { email: string }): Promise<boolean> {
  const user = await repo.findUserIdByEmail(tx, input.email.trim().toLowerCase());
  if (!user || !(await repo.deactivateStaff(tx, user.id, clock.now()))) return false;
  await compliance.auditSystem(tx, {
    type: 'identity.staff.revoked',
    agencyId: null,
    target: { type: 'user', id: user.id },
    metadata: { reasonProvided: true },
  });
  await endImpersonationsOf(tx, user.id);
  return true;
}

/** Active admins of an agency (email, name, UI locale), for notices sent by jobs (`withSystem`). */
export async function listAgencyAdmins(tx: Tx, agencyId: string) {
  return repo.listAdminRecipients(tx, agencyId);
}

/** S10-02: the agency's active members who work clients, by user id (lead round robin; the tenant's own `tx`). */
export async function activeClientMemberIds(tx: Tx, agencyId: string, limit = 500): Promise<string[]> {
  return repo.activeClientMemberIds(tx, agencyId, limit);
}

/** S10-06: which of these users are active members of the agency who work clients (the tenant's own `tx`). */
export async function activeClientMembersAmong(
  tx: Tx,
  agencyId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  return repo.activeClientMembersAmong(tx, agencyId, userIds);
}

/**
 * S11-05 (network board matching, `withSystem`): which (agency, user) pairs are active members who work clients, for
 * many agencies in one statement (`agencyId:userId` keys).
 */
export async function activeClientMembersAcross(tx: Tx, pairs: readonly { agencyId: string; userId: string }[]) {
  return repo.activeClientMembersAcross(tx, pairs);
}

/** S11-05 (`withSystem`): the active admins of many agencies (one statement), agency id → user ids, ≤ 20 each. */
export async function agencyAdminsOf(tx: Tx, agencyIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const r of await repo.activeAdminsOf(tx, agencyIds)) {
    const list = out.get(r.agencyId) ?? [];
    if (list.length < 20) list.push(r.userId);
    out.set(r.agencyId, list);
  }
  return out;
}

/** S10-02: an active member as a notification recipient (e-mail, name, UI locale), or null (`withSystem`). */
export async function memberRecipient(tx: Tx, agencyId: string, userId: string) {
  return repo.memberRecipient(tx, agencyId, userId);
}

/**
 * Members' names and e-mails by agency (S7-F5: the search index removes them from their agency's listing text), one
 * statement for all of them. Worker-facing: raw `tx` under `withSystem`.
 */
export async function teamContacts(
  tx: Tx,
  agencyIds: readonly string[],
): Promise<Map<string, { names: string[]; emails: string[] }>> {
  const out = new Map<string, { names: string[]; emails: string[] }>();
  for (const r of await repo.teamContacts(tx, [...new Set(agencyIds)])) {
    const team = out.get(r.agencyId) ?? { names: [], emails: [] };
    team.names.push(r.name);
    team.emails.push(r.email);
    out.set(r.agencyId, team);
  }
  return out;
}
