import { redirect } from 'next/navigation';

/**
 * The staff member's impersonation session ended, expired or was revoked (S1-09): pages and actions that
 * could not mint its token land here. A GET changes nothing (S1-09 review: no state change through a
 * cross-site GET); it sends the staff member back to the console, where the banner shows the session as
 * ended and its "dismiss" form (a server action) forgets it after the API confirms.
 */
export function GET(): never {
  redirect('/staff/tenants?notice=ended');
}
