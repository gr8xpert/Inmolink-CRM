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

export type NavKey = 'home' | 'security' | DashboardSection | 'staffConsole' | 'staffVerification';

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
  ['network', '/network'],
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
  ['staffAccess', '/staff-access'],
];

/**
 * The shell's navigation. No rules of its own: member sections come from the policy answer, staff
 * links from the staff role being present (every staff page checks again, and the API refuses with
 * 403). Account security acts on the signed-in user themselves, so it is hidden while a staff member is
 * acting as someone else (the web refuses it then anyway, S1-09).
 */
export function buildNav(identity: ShellIdentity): NavItem[] {
  const items: NavItem[] = [{ key: 'home', href: '/' }];
  if (identity.kind === 'member') {
    const allowed = new Set(identity.caps.sections);
    for (const [key, href] of SECTIONS) if (allowed.has(key)) items.push({ key, href });
    if (!identity.caps.impersonating) items.push({ key: 'security', href: '/account/security' });
    return items;
  }
  items.push({ key: 'security', href: '/account/security' });
  if (identity.kind === 'staff') {
    items.push({ key: 'staffConsole', href: '/staff/tenants' });
    // Data ops may not review verifications (`staff.verification.read`, S1-03): no dead link for them.
    if (identity.role !== 'STAFF_DATA_OPS') items.push({ key: 'staffVerification', href: '/staff/verification' });
  }
  return items;
}
