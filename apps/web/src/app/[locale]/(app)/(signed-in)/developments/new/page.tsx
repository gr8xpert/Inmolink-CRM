import { DevelopmentStatus } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchTaxonomy, sessionRef } from '@/server/api';
import { listingTaxonomy } from '../../listings/taxonomy';
import { CreateDevelopmentForm } from './create-form';

/** New development (S4-03): reference, name and place; its page takes over (units, prices, sharing). */
export default async function NewDevelopmentPage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const tax = await fetchTaxonomy(sessionRef(session.user));
  if (tax === 'revoked') redirect('/session/expired');
  const t = await getTranslations('developments');
  const { locations } = listingTaxonomy(tax.ok ? tax.data : null);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('create.title')}</h1>
        <Link href="/developments" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('create.intro')}</p>
      <CreateDevelopmentForm
        locations={locations}
        statuses={DevelopmentStatus.options.map((v) => ({ id: v, label: t(`options.status.${v}`) }))}
        labels={{
          ref: t('fields.ref'),
          name: t('fields.name'),
          status: t('fields.status'),
          locationId: t('fields.locationId'),
          choose: t('create.choose'),
          submit: t('create.submit'),
          fieldInvalid: t('fieldInvalid'),
        }}
        errors={{
          VALIDATION_FAILED: t('errors.VALIDATION_FAILED'),
          FORBIDDEN: t('errors.FORBIDDEN'),
          DEVELOPMENT_REF_TAKEN: t('errors.DEVELOPMENT_REF_TAKEN'),
          RATE_LIMITED: t('errors.RATE_LIMITED'),
          generic: t('errors.generic'),
        }}
        loginHref={getPathname({ href: '/login', locale })}
      />
    </div>
  );
}
