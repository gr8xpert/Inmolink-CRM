import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { fetchTaxonomy, sessionRef } from '@/server/api';
import { listingTaxonomy } from '../../listings/taxonomy';
import { SiteNotice } from '../notice';
import { SiteForm } from '../site-form';

/** Add a website (S7-01). Admins only; the API refuses everyone else. */
export default async function NewWebsitePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
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
