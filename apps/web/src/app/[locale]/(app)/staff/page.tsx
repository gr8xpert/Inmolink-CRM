import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';

/** The staff console starts at the tenants list (S1-09); 404 for non-staff before any redirect. */
export default async function StaffHomePage() {
  await requireStaff();
  return redirect({ href: '/staff/tenants', locale: await getLocale() });
}
