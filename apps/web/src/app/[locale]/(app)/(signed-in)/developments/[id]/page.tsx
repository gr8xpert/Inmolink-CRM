import { CONTENT_LOCALES, DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import dynamic from 'next/dynamic';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchDevelopmentPage, sessionRef } from '@/server/api';
import { listingTaxonomy } from '../../listings/taxonomy';
import { AccessPanel } from './access-panel';
import { DevelopmentEditor } from './development-editor';
import { UnitsPanel } from './units-panel';

// The price-list diff view and the override editor load as their own chunks.
const PriceListsPanel = dynamic(() => import('./price-lists-panel'), {
  loading: () => <div className="h-32 animate-pulse rounded-md bg-muted" />,
});
const OverridePanel = dynamic(() => import('../../listings/[id]/override-panel'), {
  loading: () => <div className="h-32 animate-pulse rounded-md bg-muted" />,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A development (S4-03): its details, sharing, units (inline edit, bulk status, CSV import) and price lists
 * (CSV upload, diff view, approval) — one round of parallel calls, then each panel saves its own changes. The
 * owner's sharing settings (`access`) mark the owner's view; another agency's development opens read-only with
 * the override panel (S3-10) for the agency's own texts. After an approval the page is refreshed and the unit
 * table (keyed by the latest approved version) starts again from the applied prices.
 */
export default async function DevelopmentPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  if (!UUID.test(id)) notFound();
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const res = await fetchDevelopmentPage(sessionRef(session.user), id);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.development.ok && res.development.status === 404) notFound();
  const t = await getTranslations('developments');
  const lang = await getTranslations('onboarding');
  const messages = (await getMessages()) as unknown as {
    developments: Record<string, unknown>;
    listings: Record<string, unknown>;
  };
  const tax = listingTaxonomy(res.taxonomy);
  const types = tax.propertyTypes.flatMap((g) => g.options);
  const locales = [DEFAULT_CONTENT_LOCALE, ...CONTENT_LOCALES.filter((l) => l !== DEFAULT_CONTENT_LOCALE)];
  const dev = res.development.ok ? res.development.data : null;
  const own = dev?.access != null;
  // The latest approved price list: an approval changed the units, so the unit table starts again from them.
  const approved = Math.max(0, ...(res.priceLists?.items ?? []).filter((p) => p.reviewedAt).map((p) => p.version));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('editor.title', { ref: dev?.ref ?? '' })}</h1>
        <Link href="/developments" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      {!dev ? (
        <p role="alert" className="text-sm text-destructive">
          {!res.development.ok && res.development.status === 403 ? t('errors.FORBIDDEN') : t('errors.generic')}
        </p>
      ) : (
        <>
          {own ? null : <p className="text-sm text-muted-foreground">{t('editor.readOnly')}</p>}
          <DevelopmentEditor
            development={dev}
            locations={tax.locations}
            readOnly={!own}
            messages={messages.developments}
          />
          {own ? (
            <AccessPanel development={dev} partners={res.partners?.items ?? []} messages={messages.developments} />
          ) : null}
          <UnitsPanel
            key={`units-${approved}`}
            developmentId={dev.id}
            currency={dev.currency}
            initial={res.units ?? { items: [], nextCursor: null }}
            propertyTypes={types}
            readOnly={!own}
            messages={messages.developments}
          />
          {own ? (
            <PriceListsPanel
              developmentId={dev.id}
              currency={dev.currency}
              initial={res.priceLists?.items ?? []}
              messages={messages.developments}
            />
          ) : (
            <OverridePanel
              targetKind="DEVELOPMENT"
              targetId={dev.id}
              ownerTexts={{}}
              contentLocales={locales.map((l) => ({ code: l, label: lang(`languages.${l}` as never) }))}
              messages={messages.listings}
            />
          )}
        </>
      )}
    </div>
  );
}
