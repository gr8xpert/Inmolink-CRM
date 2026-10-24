import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { agencyTimeZone } from '@/server/agency-time-zone';
import { fetchTaxonomy, sessionRef } from '@/server/api';
import { fetchProspect } from '@/server/prospects-api';
import { listingTaxonomy } from '../../listings/taxonomy';
import { convertProspectAction, deleteProspectAction, updateProspectAction } from '../actions';
import { fieldLabels, formErrorCode } from '../form-labels';
import { ProspectFields } from '../prospect-fields';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DONE = ['created', 'saved', 'converted'] as const;

/**
 * One seller prospect (S10-07): its details and confidential notes (edit form), and the one-click conversion into a
 * DRAFT listing — the seller is linked on the listing's private side; a converted prospect links to its listing.
 */
export default async function ProspectPage({
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
  const t = await getTranslations('acquisition');
  if (!UUID.test(id)) return localeRedirect({ href: '/acquisition', locale });
  const ref = sessionRef(session.user);
  const [prospect, tax] = await Promise.all([fetchProspect(ref, id), fetchTaxonomy(ref)]);
  if (prospect === 'revoked' || tax === 'revoked') redirect('/session/expired');
  const query = await searchParams;
  if (!prospect.ok) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
        <Link href="/acquisition" className="text-sm underline-offset-4 hover:underline">
          {t('detail.back')}
        </Link>
        <p role="alert" className="text-sm text-destructive">
          {prospect.status === 404
            ? t('errors.PROSPECT_NOT_FOUND')
            : prospect.status === 403
              ? t('errors.FORBIDDEN')
              : t('errors.generic')}
        </p>
      </div>
    );
  }
  const p = prospect.data;
  const format = await getFormatter();
  const { propertyTypes, locations } = listingTaxonomy(tax.ok ? tax.data : null);
  const error = formErrorCode(query.error);
  const done = (DONE as readonly string[]).includes(query.done ?? '') ? (query.done as (typeof DONE)[number]) : null;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{p.title}</h1>
        <Link href="/acquisition" className="text-sm underline-offset-4 hover:underline">
          {t('detail.back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('detail.stage', {
          stage: t(`stages.${p.stage}`),
          date: format.dateTime(new Date(p.stageEnteredAt), { dateStyle: 'medium' }),
        })}
      </p>
      {done ? (
        <p role="status" className="text-sm">
          {t(`detail.done.${done}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <section aria-labelledby="convert" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="convert" className="text-base font-semibold">
          {t('detail.convertTitle')}
        </h2>
        {p.listingId ? (
          <p className="text-sm">
            {t('detail.converted', {
              date: format.dateTime(new Date(p.convertedAt ?? p.stageEnteredAt), { dateStyle: 'medium' }),
            })}{' '}
            <Link href={`/listings/${p.listingId}`} className="font-medium underline underline-offset-4">
              {t('detail.openListing')}
            </Link>
          </p>
        ) : (
          <form action={convertProspectAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={p.id} />
            <p className="text-sm text-muted-foreground">
              {p.propertyTypeId && p.locationId ? t('detail.convertIntro') : t('detail.convertIncomplete')}
            </p>
            <button
              type="submit"
              disabled={!p.propertyTypeId || !p.locationId}
              className="h-9 self-start rounded-md border px-4 text-sm font-medium disabled:opacity-50"
            >
              {t('detail.convertSubmit')}
            </button>
          </form>
        )}
      </section>

      <form action={updateProspectAction} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={p.id} />
        <input type="hidden" name="version" value={p.version} />
        <ProspectFields
          labels={await fieldLabels()}
          value={p}
          propertyTypes={propertyTypes}
          locations={locations}
          notes
          timeZone={await agencyTimeZone(ref)}
        />
        <button type="submit" className="h-9 self-start rounded-md border px-4 text-sm font-medium">
          {t('form.save')}
        </button>
      </form>

      <form action={deleteProspectAction}>
        <input type="hidden" name="id" value={p.id} />
        <button type="submit" className="text-sm text-destructive underline-offset-4 hover:underline">
          {t('detail.delete')}
        </button>
      </form>
    </div>
  );
}
