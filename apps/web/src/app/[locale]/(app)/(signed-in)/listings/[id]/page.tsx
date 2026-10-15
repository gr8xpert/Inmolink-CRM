import { CONTENT_LOCALES, DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import dynamic from 'next/dynamic';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchListingEditor, sessionRef } from '@/server/api';
import { webConfig } from '@/server/env';
import { listingTaxonomy } from '../taxonomy';
import { ListingEditor } from './listing-editor';
import { QualityPanel } from './quality-panel';

// Drag-and-drop and the upload pipeline load as their own chunk (frontend rules: drag-and-drop via next/dynamic).
const MediaManager = dynamic(() => import('./media-manager'), {
  loading: () => <div className="h-48 animate-pulse rounded-md bg-muted" />,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The listing editor (S3-05): listing, content, taxonomy and media in one round of parallel calls, then the
 * client editor autosaves each change; the media manager (S3-06) below it saves each media change at once. The
 * quality panel (S3-08) above them shows the score and fix-it hints, refreshed after each saved change.
 * Another agency's or a deleted listing opens read-only.
 */
export default async function ListingEditorPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  if (!UUID.test(id)) notFound();
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const res = await fetchListingEditor(sessionRef(session.user), id);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.listing.ok && res.listing.status === 404) notFound();
  const t = await getTranslations('listings');
  const lang = await getTranslations('onboarding');
  const messages = (await getMessages()) as unknown as { listings: Record<string, unknown> };
  const config = await webConfig();
  const tax = listingTaxonomy(res.taxonomy);
  // The default content locale first, then the others as configured.
  const locales = [DEFAULT_CONTENT_LOCALE, ...CONTENT_LOCALES.filter((l) => l !== DEFAULT_CONTENT_LOCALE)];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          {t('editor.title', { ref: res.listing.ok ? (res.listing.data.ref ?? '') : '' })}
        </h1>
        <Link href="/listings" className="text-sm underline-offset-4 hover:underline">
          {t('editor.back')}
        </Link>
      </div>
      {!res.listing.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.listing.status === 403 ? t('errors.FORBIDDEN') : t('errors.generic')}
        </p>
      ) : (
        <>
          <QualityPanel listingId={res.listing.data.id} initial={res.quality} messages={messages.listings} />
          <ListingEditor
            listing={res.listing.data}
            content={res.content}
            propertyTypes={tax.propertyTypes}
            locations={tax.locations}
            features={tax.features}
            // Every content locale has a label in the onboarding catalog.
            contentLocales={locales.map((l) => ({ code: l, label: lang(`languages.${l}` as never) }))}
            mapStyleUrl={config.MAP_STYLE_URL}
            locale={locale}
            messages={messages.listings}
          />
        </>
      )}
      {res.listing.ok ? (
        <MediaManager
          listingId={res.listing.data.id}
          initial={res.media?.items ?? []}
          readOnly={res.listing.data.private === null || res.listing.data.deletedAt !== null}
          messages={messages.listings}
        />
      ) : null}
    </div>
  );
}
