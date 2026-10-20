import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { fetchSite, fetchTaxonomy, sessionRef } from '@/server/api';
import { listingTaxonomy } from '../../listings/taxonomy';
import { SiteNotice } from '../notice';
import { SiteForm } from '../site-form';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Edit a website (S7-01). Members see it; only admins can save (the API refuses everyone else). */
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
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ref = sessionRef(session.user);
  const [res, tax] = await Promise.all([fetchSite(ref, id), fetchTaxonomy(ref)]);
  if (res === 'revoked' || tax === 'revoked') redirect('/session/expired');
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
      <SiteForm site={res.data} locations={locations} propertyTypes={propertyTypes} defaultLocales={[locale]} />
    </div>
  );
}
