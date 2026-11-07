import { CONTENT_LOCALES } from '@inmolink/i18n';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { listingIdsOf } from '../ids';
import { WindowCardsForm } from '../window-cards-form';

/**
 * Window cards (R2-06): the listings picked in the listings table (`?listingIds=`, up to 50), a template, a format and
 * a language; one file comes back. The QR code of every card opens that listing's live, branded page.
 */
export default async function NewWindowCardsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const t = await getTranslations('selections');
  const params = await searchParams;
  const ids = listingIdsOf(params.listingIds);
  const k = (key: string) => (t as unknown as (key: string) => string)(`windowCards.${key}`);
  const group = (name: string, keys: readonly string[]) => Object.fromEntries(keys.map((x) => [x, k(`${name}.${x}`)]));
  const labels = {
    template: k('template'),
    format: k('format'),
    locale: k('locale'),
    submit: k('submit'),
    working: k('working'),
    ready: k('ready'),
    download: k('download'),
    failed: k('failed'),
    layouts: group('layouts', ['classic', 'split', 'gallery', 'bold']),
    orientations: group('orientations', ['PORTRAIT', 'LANDSCAPE']),
    formats: group('formats', ['PDF', 'HTML']),
    errors: group('errors', [
      'generic',
      'DOCUMENT_LISTINGS_INVALID',
      'VALIDATION_FAILED',
      'RATE_LIMITED',
      'PLAN_REQUIRED',
    ]),
  };
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('windowCards.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('windowCards.intro')}</p>
      {ids.length === 0 ? (
        <p className="text-sm" data-testid="window-cards-none">
          {t('windowCards.none')}
        </p>
      ) : (
        <>
          <p className="text-sm font-medium">{t('windowCards.count', { count: ids.length })}</p>
          <WindowCardsForm
            listingIds={ids}
            locales={[...CONTENT_LOCALES]}
            defaultLocale={CONTENT_LOCALES.includes(locale as never) ? locale : (CONTENT_LOCALES[0] ?? 'en')}
            labels={labels}
          />
        </>
      )}
      <Link href="/listings" className="text-sm underline-offset-4 hover:underline">
        {t('windowCards.back')}
      </Link>
    </div>
  );
}
