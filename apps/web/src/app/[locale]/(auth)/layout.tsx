import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';

/** Centered card for the signed-out pages; S16-04: the privacy notice, terms and cookie policy under it. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('legal');
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-muted/40 p-4 focus:outline-none"
    >
      <div className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-sm">{children}</div>
      <nav aria-label={t('nav.label')} className="flex flex-wrap justify-center gap-3 text-xs text-muted-foreground">
        <Link href="/legal/privacy" className="underline">
          {t('nav.privacy')}
        </Link>
        <Link href="/legal/terms" className="underline">
          {t('nav.terms')}
        </Link>
        <Link href="/legal/cookies" className="underline">
          {t('nav.cookies')}
        </Link>
      </nav>
    </main>
  );
}
