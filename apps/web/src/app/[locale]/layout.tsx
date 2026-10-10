import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { routing } from '@/i18n/routing';
import '../globals.css';

/**
 * Root layout: every page lives under a locale prefix (S0-11). Dashboard pages are per-user and
 * dynamic, so no `generateStaticParams` (unlike apps/public).
 */
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
        {/* No catalogs in the client bundle: pages translate on the server. A client subtree that
            needs strings wraps itself in a provider with only its namespaces. */}
        <NextIntlClientProvider messages={null}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
