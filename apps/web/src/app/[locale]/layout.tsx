import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { CookieBanner } from '@/components/legal/cookie-banner';
import { getPathname } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import '../globals.css';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'shell' });
  // The dashboard is never indexed (S0-11: no hreflang either).
  return { title: t('meta.title'), robots: { index: false, follow: false } };
}

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
  const messages = await getMessages();
  const legal = await getTranslations({ locale, namespace: 'legal' });
  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        {/* Pages translate on the server, so the client gets only what client components translate
            themselves: the error boundary's strings (S1-10). Other islands take their strings as props. */}
        <NextIntlClientProvider messages={{ shell: { error: messages.shell.error } }}>
          {children}
        </NextIntlClientProvider>
        {/* S16-04: the cookie choice (only strictly necessary cookies today; optional ones wait for `all`) */}
        <CookieBanner
          policyHref={getPathname({ href: '/legal/cookies', locale })}
          text={{
            text: legal('consent.text'),
            essentialOnly: legal('consent.essentialOnly'),
            acceptAll: legal('consent.acceptAll'),
            policy: legal('consent.policy'),
            label: legal('consent.label'),
          }}
        />
      </body>
    </html>
  );
}
