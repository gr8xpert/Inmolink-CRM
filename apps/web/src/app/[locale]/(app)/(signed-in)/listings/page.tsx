import { buttonVariants, EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchListings, fetchTaxonomy, sessionRef } from '@/server/api';
import { listingTaxonomy } from './taxonomy';

/**
 * The agency's listings (S3-05): newest first, 50 per page (keyset cursor), optionally only the caller's own.
 * Each row opens the editor.
 */
export default async function ListingsPage(props: { searchParams: Promise<{ cursor?: string; mine?: string }> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const q = await props.searchParams;
  const cursor = typeof q.cursor === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(q.cursor) ? q.cursor : undefined;
  const mine = q.mine === '1';
  const ref = sessionRef(session.user);
  const [res, tax] = await Promise.all([fetchListings(ref, { cursor, mine }), fetchTaxonomy(ref)]);
  if (res === 'revoked' || tax === 'revoked') redirect('/session/expired');
  const t = await getTranslations('listings');
  const format = await getFormatter();
  const names = listingTaxonomy(tax.ok ? tax.data : null);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href={mine ? '/listings' : '/listings?mine=1'} className="text-sm underline-offset-4 hover:underline">
            {mine ? t('all') : t('mine')}
          </Link>
          <Link href="/listings/new" className={buttonVariants()}>
            {t('new')}
          </Link>
        </div>
      </div>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.FORBIDDEN') : t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="listings-table">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="p-2 font-medium">{t('columns.ref')}</th>
                  <th className="p-2 font-medium">{t('columns.type')}</th>
                  <th className="p-2 font-medium">{t('columns.location')}</th>
                  <th className="p-2 font-medium">{t('columns.price')}</th>
                  <th className="p-2 font-medium">{t('columns.status')}</th>
                  <th className="p-2 font-medium">{t('columns.visibility')}</th>
                  <th className="p-2 font-medium">{t('columns.created')}</th>
                </tr>
              </thead>
              <tbody>
                {res.data.items.map((l) => (
                  <tr key={l.id} className="border-t">
                    <td className="p-2 font-mono">
                      <Link href={`/listings/${l.id}`} className="underline-offset-4 hover:underline">
                        {l.ref}
                      </Link>
                    </td>
                    <td className="p-2">{names.typeName(l.propertyTypeId) ?? '—'}</td>
                    <td className="p-2">{names.locationName(l.locationId)?.split(' › ').at(-1) ?? '—'}</td>
                    <td className="p-2">
                      {l.price
                        ? format.number(l.price.amountCents / 100, { style: 'currency', currency: l.price.currency })
                        : '—'}
                    </td>
                    <td className="p-2">{t(`editor.options.status.${l.status}`)}</td>
                    <td className="p-2">{t(`editor.options.visibility.${l.visibility}`)}</td>
                    <td className="p-2">{format.dateTime(new Date(l.createdAt), { dateStyle: 'medium' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {res.data.nextCursor ? (
            <Link
              href={`/listings?${new URLSearchParams({ cursor: res.data.nextCursor, ...(mine ? { mine: '1' } : {}) })}`}
              className="self-end text-sm underline-offset-4 hover:underline"
            >
              {t('more')}
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}
