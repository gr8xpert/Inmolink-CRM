import { LEGAL_DOCS } from '@inmolink/contracts';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { CookieSettingsButton } from '@/components/legal/cookie-settings-button';
import { Link } from '@/i18n/navigation';
import { LEGAL_NAV_KEYS } from './docs';

/** The legal pages (S16-04): public, signed in or not; one nav for the four documents. */
export default async function LegalLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('legal');
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <nav aria-label={t('nav.label')} className="flex flex-wrap gap-4 text-sm">
        {LEGAL_DOCS.map((doc) => (
          <Link key={doc} href={`/legal/${doc}`} className="underline">
            {t(`nav.${LEGAL_NAV_KEYS[doc]}`)}
          </Link>
        ))}
        <CookieSettingsButton label={t('consent.settings')} />
      </nav>
      <main id="main" tabIndex={-1} className="flex flex-col gap-4 focus:outline-none">
        {children}
      </main>
    </div>
  );
}
