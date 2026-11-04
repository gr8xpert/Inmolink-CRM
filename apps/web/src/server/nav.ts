import type { DashboardSection, MyCapabilitiesDto, StaffRole } from '@inmolink/contracts';

/**
 * Who the dashboard shell is drawn for (S1-10): a member with the capabilities their agency's policies
 * grant (`GET /v1/me/capabilities`), a staff member (`GET /v1/staff/me`), or a signed-in user the API
 * told us nothing about (refused or down) — they get the pages every account has.
 */
export type ShellIdentity =
  | { kind: 'member'; caps: MyCapabilitiesDto }
  | { kind: 'staff'; role: StaffRole }
  | { kind: 'unknown' };

export type NavKey =
  | 'home'
  | 'security'
  | 'support'
  | 'publicProfile'
  | DashboardSection
  | 'staffConsole'
  | 'staffVerification';

export interface NavItem {
  /** Message key under `shell.nav`. */
  key: NavKey;
  /** Locale-less path; the locale-aware `Link` adds the prefix. */
  href: string;
}

/** Display order of the member sections; the API decides which of them the caller gets. */
const SECTIONS: ReadonlyArray<readonly [DashboardSection, string]> = [
  ['listings', '/listings'],
  ['pipeline', '/pipeline'],
  ['tasks', '/tasks'],
  ['calendar', '/calendar'],
  ['acquisition', '/acquisition'],
  ['contacts', '/contacts'],
  ['inbox', '/inbox'],
  ['selections', '/selections'],
  ['network', '/network'],
  ['networkBoard', '/network/board'],
  ['chat', '/chat'],
  ['collaborations', '/collaborations'],
  ['developments', '/developments'],
  ['imports', '/imports'],
  ['team', '/team'],
  ['websites', '/websites'],
  ['portals', '/portals'],
  ['preferredAgencies', '/preferred-agencies'],
  ['profile', '/profile'],
  ['settings', '/settings'],
  ['verification', '/verification'],
  ['apiKeys', '/api-keys'],
  ['dataExport', '/data-export'],
  ['billing', '/billing'],
  ['staffAccess', '/staff-access'],
];

/**
 * The shell's navigation. No rules of its own: member sections come from the policy answer, staff
 * links from the staff role being present (every staff page checks again, and the API refuses with
 * 403). Account security acts on the signed-in user themselves, so it is hidden while a staff member is
 * acting as someone else (the web refuses it then anyway, S1-09).
 */
/**
 * Whether the screens offer admin-only controls (S17-F34): agency and developer admins, not staff acting as one and not
 * Client Mode. Only what the screens show: each module's `policy.ts` decides, and the API refuses everyone else.
 */
export function isAgencyAdmin(identity: ShellIdentity): boolean {
  return (
    identity.kind === 'member' &&
    !identity.caps.impersonating &&
    !identity.caps.clientMode &&
    (identity.caps.role === 'AGENCY_ADMIN' || identity.caps.role === 'DEVELOPER_ADMIN')
  );
}

/** Whether to offer the contact import (S17-F29, S17-F30): admins, as above (`crm.contacts.import`). */
export function canImportContacts(identity: ShellIdentity): boolean {
  return isAgencyAdmin(identity);
}

/**
 * Whether the member is showing the agency to a client (S17-F35). Pages the API closes in Client Mode say so instead of
 * asking for data that is refused.
 */
export function inClientMode(identity: ShellIdentity): boolean {
  return identity.kind === 'member' && identity.caps.clientMode;
}

/**
 * Staff console pages that data ops cannot open (S17-F36; `staff.verification.read` in the agencies policy, the audit
 * viewer is for super admins and support): the layout links them to the other roles only.
 */
export function staffCanReviewAndAudit(role: StaffRole): boolean {
  return role !== 'STAFF_DATA_OPS';
}

export function buildNav(identity: ShellIdentity): NavItem[] {
  const items: NavItem[] = [{ key: 'home', href: '/' }];
  if (identity.kind === 'member') {
    const allowed = new Set(identity.caps.sections);
    for (const [key, href] of SECTIONS) if (allowed.has(key)) items.push({ key, href });
    // S13-05: every member may ask support (never in Client Mode: tickets are the agency's own business).
    if (!identity.caps.clientMode) items.push({ key: 'support', href: '/support' });
    // S15-F10: the member's own portal profile (theirs to change: not in Client Mode, not while staff act as them).
    if (!identity.caps.clientMode && !identity.caps.impersonating) {
      items.push({ key: 'publicProfile', href: '/account/public-profile' });
    }
    if (!identity.caps.impersonating) items.push({ key: 'security', href: '/account/security' });
    return items;
  }
  items.push({ key: 'security', href: '/account/security' });
  if (identity.kind === 'staff') {
    items.push({ key: 'staffConsole', href: '/staff/tenants' });
    // Data ops may not review verifications (`staff.verification.read`, S1-03): no dead link for them.
    if (staffCanReviewAndAudit(identity.role)) items.push({ key: 'staffVerification', href: '/staff/verification' });
  }
  return items;
}
