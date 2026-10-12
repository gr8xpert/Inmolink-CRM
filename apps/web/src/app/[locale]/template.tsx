import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { ImpersonationBanner } from './impersonation-banner';

/**
 * Per-navigation wrapper (S1-09 review): unlike the layout, a template renders again on every
 * navigation, so the impersonation banner always shows the session as it is now. The skip link comes
 * first (S1-10): every page under a locale renders its content into `main#main`.
 */
export default async function LocaleTemplate({ children }: { children: ReactNode }) {
  const t = await getTranslations('shell');
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        {t('skipToContent')}
      </a>
      <ImpersonationBanner />
      {children}
    </>
  );
}
