import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';

/**
 * Staff console shell (S1-09, PLAN §7 M20). Only active staff see it (`requireStaff`: 404 for anyone
 * else); every page below checks again, and the API refuses non-staff with 403.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const { me } = await requireStaff();
  const t = await getTranslations('staff');
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <p className="font-semibold">{t('console.title')}</p>
        <nav aria-label={t('console.nav')} className="flex flex-wrap gap-4 text-sm">
          <Link href="/staff/tenants" className="font-medium underline-offset-4 hover:underline">
            {t('console.tenants')}
          </Link>
          <Link href="/staff/verification" className="font-medium underline-offset-4 hover:underline">
            {t('console.verification')}
          </Link>
          <Link href="/staff/audit" className="font-medium underline-offset-4 hover:underline">
            {t('console.audit')}
          </Link>
        </nav>
        <p className="text-xs text-muted-foreground">{t(`roles.${me.role}`)}</p>
      </header>
      {children}
    </div>
  );
}
