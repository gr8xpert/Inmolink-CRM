import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { agencyTimeZone } from '@/server/agency-time-zone';
import { sessionRef } from '@/server/api';
import { fetchSelections } from '@/server/selections-api';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * The agency's selections (S13-F13), newest first: status, items and the client's views. Likes and enquiries per
 * selection are on its page. A selection is created from a bookmark folder or from listing ids (`/selections/new`).
 */
export default async function SelectionsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const ref = sessionRef(session.user);
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchSelections(ref, cursor);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('selections');
  const format = await getFormatter();
  const timeZone = await agencyTimeZone(ref);
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone }) : '—';

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link href="/selections/new" className="ml-auto text-sm font-medium underline-offset-4 hover:underline">
          {t('new')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" data-testid="selections">
            <thead className="bg-muted">
              <tr>
                <th className="p-2">{t('columns.title')}</th>
                <th className="p-2">{t('columns.status')}</th>
                <th className="p-2">{t('columns.items')}</th>
                <th className="p-2">{t('columns.views')}</th>
                <th className="p-2">{t('columns.lastViewed')}</th>
                <th className="p-2">{t('columns.created')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {res.data.items.map((s) => (
                <tr key={s.id}>
                  <td className="p-2">
                    <Link href={`/selections/${s.id}`} className="font-medium underline-offset-4 hover:underline">
                      {s.title}
                    </Link>
                  </td>
                  <td className="p-2">{t(`statuses.${s.status}`)}</td>
                  <td className="p-2">{format.number(s.itemCount)}</td>
                  <td className="p-2">{format.number(s.stats.views)}</td>
                  <td className="p-2 whitespace-nowrap">{when(s.stats.lastViewedAt)}</td>
                  <td className="p-2 whitespace-nowrap">{when(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/selections', query: { cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('next')}
        </Link>
      ) : null}
    </div>
  );
}
