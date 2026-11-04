import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { fetchTaxonomy, sessionRef } from '@/server/api';
import { inClientMode, isAgencyAdmin } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { listingTaxonomy } from '../../listings/taxonomy';
import { SiteNotice } from '../notice';
import { SiteForm } from '../site-form';

/** Add a website (S7-01). Admins only: everyone else sees a sentence (S17-F34), and the API refuses them anyway. */
export default async function NewWebsitePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const admin = shell !== null && isAgencyAdmin(shell.identity);
  if (!admin) {
    const denied = await getTranslations('websites');
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        <h1 className="text-xl font-semibold">{denied('form.createTitle')}</h1>
        <p className="rounded-md bg-muted p-3 text-sm" data-testid="admin-only">
          {denied('form.adminOnly')}
        </p>
      </div>
    );
  }
  const tax = await fetchTaxonomy(sessionRef(session.user));
  if (tax === 'revoked') redirect('/session/expired');
  const { locations, propertyTypes } = listingTaxonomy(tax.ok ? tax.data : null);
  const t = await getTranslations('websites');
  const q = await searchParams;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('form.createTitle')}</h1>
      <SiteNotice error={q.error} />
      <SiteForm locations={locations} propertyTypes={propertyTypes} defaultLocales={[locale]} />
    </div>
  );
}
