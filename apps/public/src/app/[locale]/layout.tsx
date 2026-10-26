import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { routing } from '@/i18n/routing';
import '../globals.css';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

/** Root layout: every page lives under a locale prefix (S0-11). */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        {/* No catalogs and no intl provider in the client bundle (S15-01: less to hydrate): pages translate on the
            server and hand client islands their strings as props. A client subtree that needs next-intl's hooks
            wraps itself in a provider with only its namespaces. */}
        {children}
      </body>
    </html>
  );
}
