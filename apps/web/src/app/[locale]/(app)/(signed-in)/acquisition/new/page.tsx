import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchTaxonomy, sessionRef } from '@/server/api';
import { fetchSellerContacts } from '@/server/prospects-api';
import { listingTaxonomy } from '../../listings/taxonomy';
import { createProspectAction } from '../actions';
import { fieldLabels, formErrorCode } from '../form-labels';
import { ProspectFields } from '../prospect-fields';

/** New seller prospect (S10-07): who sells, where, what and for about how much; it starts in "New". */
export default async function NewProspectPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const ref = sessionRef(session.user);
  const [tax, sellers] = await Promise.all([fetchTaxonomy(ref), fetchSellerContacts(ref)]);
  if (tax === 'revoked' || sellers === 'revoked') redirect('/session/expired');
  const t = await getTranslations('acquisition');
  const { propertyTypes, locations } = listingTaxonomy(tax.ok ? tax.data : null);
  const error = formErrorCode((await searchParams).error);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('form.newTitle')}</h1>
        <Link href="/acquisition" className="text-sm underline-offset-4 hover:underline">
          {t('detail.back')}
        </Link>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      <form action={createProspectAction} className="flex flex-col gap-3">
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <ProspectFields
          labels={await fieldLabels()}
          sellers={sellers.ok ? sellers.data.items : []}
          propertyTypes={propertyTypes}
          locations={locations}
          notes
        />
        <button type="submit" className="h-9 self-start rounded-md border px-4 text-sm font-medium">
          {t('form.create')}
        </button>
      </form>
    </div>
  );
}
