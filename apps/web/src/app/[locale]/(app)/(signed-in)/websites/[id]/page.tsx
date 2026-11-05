import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { fetchSite, fetchSiteFeed, fetchTaxonomy, sessionRef } from '@/server/api';
import { webConfig } from '@/server/env';
import { inClientMode, isAgencyAdmin } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { listingTaxonomy } from '../../listings/taxonomy';
import { SiteNotice } from '../notice';
import { SiteForm } from '../site-form';
import { EmbedCard, FeedCard } from './feed-card';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Edit a website (S7-01). Members see it; only admins can save (the API refuses everyone else), so others read it without the
 * controls (S17-F44). S7-F8: its XML feed
 * card, and the embed address of an IFRAME site.
 */
export default async function EditWebsitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const admin = shell !== null && isAgencyAdmin(shell.identity);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ref = sessionRef(session.user);
  const [res, tax, feed] = await Promise.all([fetchSite(ref, id), fetchTaxonomy(ref), fetchSiteFeed(ref, id)]);
  if (res === 'revoked' || tax === 'revoked' || feed === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 404) notFound();
  const t = await getTranslations('websites');
  const q = await searchParams;
  if (!res.ok) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      </div>
    );
  }
  const { locations, propertyTypes } = listingTaxonomy(tax.ok ? tax.data : null);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('form.editTitle', { name: res.data.name })}</h1>
      <SiteNotice error={q.error} />
      {admin ? null : (
        <p className="rounded-md bg-muted p-3 text-sm" data-testid="admin-only">
          {t('form.readOnly')}
        </p>
      )}
      <SiteForm
        site={res.data}
        locations={locations}
        propertyTypes={propertyTypes}
        defaultLocales={[locale]}
        readOnly={!admin}
      />
      {res.data.mode === 'IFRAME' ? (
        <EmbedCard site={res.data} pagesUrl={(await webConfig()).PUBLIC_PAGES_URL} />
      ) : null}
      <FeedCard site={res.data} feed={feed.ok ? feed.data : null} notice={q.feed} error={q.feedError} admin={admin} />
    </div>
  );
}
