import { TransactionType } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchTaxonomy, sessionRef } from '@/server/api';
import { listingTaxonomy } from '../taxonomy';
import { CreateListingForm } from './create-form';

/** New listing (S3-05): what and where, then the editor takes over (a DRAFT, PRIVATE listing). */
export default async function NewListingPage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const tax = await fetchTaxonomy(sessionRef(session.user));
  if (tax === 'revoked') redirect('/session/expired');
  const t = await getTranslations('listings');
  const { propertyTypes, locations } = listingTaxonomy(tax.ok ? tax.data : null);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('create.title')}</h1>
        <Link href="/listings" className="text-sm underline-offset-4 hover:underline">
          {t('editor.back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('create.intro')}</p>
      <CreateListingForm
        propertyTypes={propertyTypes}
        locations={locations}
        transactionTypes={TransactionType.options.map((v) => ({
          id: v,
          label: t(`editor.options.transactionType.${v}`),
        }))}
        labels={{
          transactionType: t('editor.fields.transactionType'),
          propertyTypeId: t('editor.fields.propertyTypeId'),
          locationId: t('editor.fields.locationId'),
          choose: t('create.choose'),
          submit: t('create.submit'),
          fieldInvalid: t('fieldInvalid'),
        }}
        pickerLabels={{ search: t('picker.locationSearch'), showing: t('picker.locationShowing') }}
        errors={{
          VALIDATION_FAILED: t('errors.VALIDATION_FAILED'),
          FORBIDDEN: t('errors.FORBIDDEN'),
          RATE_LIMITED: t('errors.RATE_LIMITED'),
          generic: t('errors.generic'),
        }}
        loginHref={getPathname({ href: '/login', locale })}
      />
    </div>
  );
}
