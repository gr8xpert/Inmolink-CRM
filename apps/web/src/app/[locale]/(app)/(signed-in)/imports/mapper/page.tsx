import { CONTENT_LOCALES, DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { MapperEntry } from './mapper-entry';

/** The visual XML mapper (S6-04). Admins only; the API refuses everyone else. */
export default async function MapperPage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const t = await getTranslations('imports.mapper');
  const messages = (await getMessages()) as unknown as { imports: { mapper: Record<string, unknown> } };
  const locales = [DEFAULT_CONTENT_LOCALE, ...CONTENT_LOCALES.filter((l) => l !== DEFAULT_CONTENT_LOCALE)];
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link href="/imports" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <MapperEntry messages={messages.imports.mapper} locales={locales} defaultLocale={DEFAULT_CONTENT_LOCALE} />
    </div>
  );
}
