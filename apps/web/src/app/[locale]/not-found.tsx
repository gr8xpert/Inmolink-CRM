import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

/**
 * Localized 404 (S1-10) for unknown paths under a locale and for pages that call `notFound()` — the
 * staff console among them, so a non-staff visitor sees exactly this page there (S1-09).
 */
export default async function NotFound() {
  const t = await getTranslations('shell');
  return (
    <main id="main" tabIndex={-1} className="mx-auto flex max-w-xl flex-col gap-3 p-6 focus:outline-none">
      <h1 className="text-xl font-semibold">{t('notFound.title')}</h1>
      <p className="text-sm">{t('notFound.body')}</p>
      <Link href="/" className="text-sm font-medium underline underline-offset-4">
        {t('notFound.home')}
      </Link>
    </main>
  );
}
