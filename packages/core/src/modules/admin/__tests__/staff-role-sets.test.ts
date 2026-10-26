import { STAFF_OPERATION_ROLES, STAFF_ROLES, SUPER_ADMIN_ROLES, SUPPORT_AGENT_ROLES } from '@inmolink/contracts';
import { registry, staffRoleSql } from '@inmolink/db';
import { describe, expect, it } from 'vitest';
import type { StaffCtx, StaffRole } from '../../../context';
import * as billing from '../../billing';
import * as identity from '../../identity';
import * as support from '../../support';
import { canStaff } from '../policy';

/**
 * S14-F2: every staff RLS predicate in the tenant registry and the staff policy guarding the same write accept exactly
 * the same roles. A new staff predicate fails here until it is mapped to its policy.
 */

const staff = (role: StaffRole): StaffCtx => ({
  tx: {} as StaffCtx['tx'],
  actor: { kind: 'staff', userId: '01900000-0000-7000-8000-0000000000bb', role },
  locale: 'en',
  requestId: 'test',
});

type Policy = (ctx: StaffCtx) => boolean;
const billingGrant: Policy = (c) => billing.canStaff(c, 'staff.billing.grant');
const runOperation: Policy = (c) => canStaff(c, 'staff.admin.runOperation');
const setFlag: Policy = (c) => canStaff(c, 'staff.admin.setFlag');
const supportWrite: Policy = (c) => support.canStaff(c, 'staff.support.write');
const manageImpersonation: Policy = (c) => identity.canStaff(c, 'staff.impersonation.manage');

/** Registry path (`tenant|global.<table>.<field…>`, `[event type]` for one outbox clause) → the policy it mirrors. */
const POLICY_OF: Record<string, Policy> = {
  'tenant.outbox_events.staff.insert[billing.plan.changed]': billingGrant,
  'tenant.outbox_events.staff.insert[admin.operation.requested]': runOperation,
  'tenant.outbox_events.staff.insert[support.message.posted]': supportWrite,
  'tenant.billing_plan_grants.staff.insert': billingGrant,
  'tenant.billing_plan_grants.staff.update': billingGrant,
  'tenant.billing_price_locks.staff.insert': billingGrant,
  'tenant.billing_price_locks.staff.update': billingGrant,
  'tenant.staff_impersonations.staff.select': manageImpersonation,
  'tenant.staff_impersonations.staff.update': manageImpersonation,
  'tenant.support_tickets.staff.update': supportWrite,
  'tenant.support_ticket_messages.staff.insert': supportWrite,
  // No staff path writes the catalog (S13 review); a write would be a plan change, so super admins as for grants.
  'global.billing_catalog_items.staffWrite.sql': billingGrant,
  'global.billing_prices.staffWrite.sql': billingGrant,
  'global.feature_flags.staffWrite.sql': setFlag,
  'global.support_ticket_notes.staffWrite.sql': supportWrite,
  'global.staff_operations.staffWrite.sql': runOperation,
};

const ROLE_MATCH = /s\.role (?:= '([A-Z_]+)'|in \(([^)]*)\))/g;

/** The roles one SQL string's staff predicates accept (all predicates in it must name the same set). */
function rolesIn(sql: string): string[] {
  const sets = [...sql.matchAll(ROLE_MATCH)].map((m) =>
    (m[1] ? [m[1]] : (m[2] ?? '').split(',').map((r) => r.trim().replace(/'/g, ''))).sort().join(','),
  );
  expect(new Set(sets).size, sql).toBe(1);
  return (sets[0] ?? '').split(',');
}

/** Every staff predicate in the registry, by path; a string mixing several (the outbox insert) splits per event type. */
function staffPredicates(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (!value.includes('public.staff_users s')) return;
      const all = [...value.matchAll(ROLE_MATCH)];
      if (all.length === 1) {
        out.set(path, rolesIn(value));
        return;
      }
      for (const clause of value.split(/\) or \(/)) {
        if (!clause.includes('public.staff_users s')) continue;
        const type = /type = '([^']+)'/.exec(clause)?.[1];
        expect(type, `${path}: a clause with a staff predicate names its event type`).toBeDefined();
        out.set(`${path}[${type}]`, rolesIn(clause));
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    }
  };
  walk(registry.tenant, 'tenant');
  walk(registry.global, 'global');
  return out;
}

describe('staff role sets (S14-F2)', () => {
  it('[S14-F2] each staff RLS predicate and its policy accept exactly the same roles', () => {
    const predicates = staffPredicates();
    expect([...predicates.keys()].sort()).toEqual(Object.keys(POLICY_OF).sort());
    for (const [path, rlsRoles] of predicates) {
      const policy = POLICY_OF[path];
      if (!policy) throw new Error(`unmapped staff predicate ${path}`);
      const policyRoles = STAFF_ROLES.filter((r) => policy(staff(r))).sort();
      expect(policyRoles, path).toEqual([...rlsRoles].sort());
    }
  });

  it('[S14-F2] the registry predicates are built from the contracts role sets', () => {
    const predicates = staffPredicates();
    const sets = new Set([...predicates.values()].map((r) => [...r].sort().join(',')));
    const known = [SUPER_ADMIN_ROLES, STAFF_OPERATION_ROLES, SUPPORT_AGENT_ROLES].map((r) => [...r].sort().join(','));
    for (const s of sets) expect(known).toContain(s);
  });

  it('[S14-F2] staffRoleSql renders the active-staff predicate and refuses an empty or malformed role list', () => {
    expect(staffRoleSql(SUPER_ADMIN_ROLES)).toBe(
      "exists (select 1 from public.staff_users s where s.user_id = app_user_id() and s.role = 'SUPER_ADMIN' and s.deactivated_at is null)",
    );
    expect(staffRoleSql(SUPPORT_AGENT_ROLES)).toBe(
      "exists (select 1 from public.staff_users s where s.user_id = app_user_id() and s.role in ('SUPER_ADMIN', 'STAFF_SUPPORT') and s.deactivated_at is null)",
    );
    expect(() => staffRoleSql([])).toThrow();
    expect(() => staffRoleSql(["SUPER_ADMIN') or (true"])).toThrow();
  });
});
