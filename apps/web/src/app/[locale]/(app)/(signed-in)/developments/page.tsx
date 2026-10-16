import { buttonVariants, EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchDevelopments, sessionRef } from '@/server/api';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/** The agency's developments (S4-03): 50 per page (keyset cursor), newest first, each opening its page. */
export default async function DevelopmentsPage(props: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const { cursor } = await props.searchParams;
  const res = await fetchDevelopments(
    sessionRef(session.user),
    typeof cursor === 'string' && CURSOR.test(cursor) ? cursor : undefined,
  );
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('developments');
  const format = await getFormatter();

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        <Link href="/developments/new" className={buttonVariants()}>
          {t('new')}
        </Link>
      </div>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.FORBIDDEN') : t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">{t('columns.ref')}</th>
                <th className="px-3 py-2 font-medium">{t('columns.name')}</th>
                <th className="px-3 py-2 font-medium">{t('columns.status')}</th>
                <th className="px-3 py-2 font-medium">{t('columns.access')}</th>
                <th className="px-3 py-2 font-medium">{t('columns.verified')}</th>
                <th className="px-3 py-2 font-medium">{t('columns.updated')}</th>
              </tr>
            </thead>
            <tbody>
              {res.data.items.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className="px-3 py-2 font-mono">{d.ref}</td>
                  <td className="px-3 py-2">
                    <Link href={`/developments/${d.id}`} className="underline-offset-4 hover:underline">
                      {d.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{t(`options.status.${d.status}`)}</td>
                  <td className="px-3 py-2">{d.access ? t(`options.access.${d.access.kind}`) : '—'}</td>
                  <td className="px-3 py-2">
                    {d.lastVerifiedAt
                      ? format.dateTime(new Date(d.lastVerifiedAt), { dateStyle: 'medium' })
                      : t('never')}
                  </td>
                  <td className="px-3 py-2">{format.dateTime(new Date(d.updatedAt), { dateStyle: 'medium' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={`/developments?${new URLSearchParams({ cursor: res.data.nextCursor })}`}
          className="self-end text-sm underline-offset-4 hover:underline"
        >
          {t('more')}
        </Link>
      ) : null}
    </div>
  );
}
