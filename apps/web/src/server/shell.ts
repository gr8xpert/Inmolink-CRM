import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/auth';
import { fetchMyCapabilities, sessionRef } from './api';
import { buildNav, type NavItem, type ShellIdentity } from './nav';
import { fetchStaffMe } from './staff-api';

export interface Shell {
  user: { name: string; email: string };
  identity: ShellIdentity;
  nav: NavItem[];
}

/**
 * What the dashboard shell shows for this request (S1-10), once per request (`cache`). Null when
 * signed out: the shell is not drawn and each page decides (the login redirect, or the staff pages'
 * 404). Members get their capabilities from the API; a 403 there means no agency, so we ask the staff
 * API. A revoked session ends here, a missing second factor goes to the challenge (in `apiRequest`).
 */
export const loadShell = cache(async (): Promise<Shell | null> => {
  const s = await auth();
  if (!s?.user?.id) return null;
  const session = sessionRef(s.user);
  const user = { name: s.user.name, email: s.user.email };
  const caps = await fetchMyCapabilities(session);
  if (caps === 'revoked') redirect('/session/expired');
  let identity: ShellIdentity = { kind: 'unknown' };
  if (caps.ok) {
    identity = { kind: 'member', caps: caps.data };
  } else if (caps.status === 403) {
    const staff = await fetchStaffMe(session);
    if (staff === 'revoked') redirect('/session/expired');
    if (staff.ok) identity = { kind: 'staff', role: staff.data.role };
  }
  return { user, identity, nav: buildNav(identity) };
});
