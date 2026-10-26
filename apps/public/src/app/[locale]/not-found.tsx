import { getLocale, getTranslations } from 'next-intl/server';
import { PortalShell } from '@/portal/ui/shell';
import { searchPath } from '@/portal/urls';

/** The portal's 404 (S15-01): a way back into the search instead of a dead end. */
export default async function NotFound() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: 'portal' });
  return (
    <PortalShell locale={locale} alternates={{}}>
      <div className="mx-auto max-w-6xl px-4 py-20">
        <h1 className="text-4xl font-extrabold tracking-tight">{t('notFound.title')}</h1>
        <p className="mt-4 max-w-[56ch] text-stone">{t('notFound.body')}</p>
        <a href={searchPath(locale)} className="mt-8 inline-block rounded-md bg-sea px-5 py-3 font-semibold text-white">
          {t('notFound.search')}
        </a>
      </div>
    </PortalShell>
  );
}
