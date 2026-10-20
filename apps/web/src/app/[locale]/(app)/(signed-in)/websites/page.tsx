import type { SiteDto } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchSites, sessionRef } from '@/server/api';
import { SiteNotice } from './notice';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Websites (S7-01): the agency's sites with how each runs, its inventory policy, prefix and languages; admins add and
 * edit them (the API refuses everyone else).
 */
export default async function WebsitesPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchSites(sessionRef(session.user), cursor);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('websites');

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <div>
        <Link href="/websites/new" className="text-sm font-medium underline-offset-4 hover:underline">
          {t('add')}
        </Link>
      </div>
      <SiteNotice done={params.done} error={params.error} />
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" data-testid="websites">
            <thead className="bg-muted">
              <tr>
                <th className="p-2">{t('columns.name')}</th>
                <th className="p-2">{t('columns.mode')}</th>
                <th className="p-2">{t('columns.policy')}</th>
                <th className="p-2">{t('columns.prefix')}</th>
                <th className="p-2">{t('columns.locales')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {res.data.items.map((s: SiteDto) => (
                <tr key={s.id}>
                  <td className="p-2">
                    <Link href={`/websites/${s.id}`} className="font-medium underline-offset-4 hover:underline">
                      {s.name}
                    </Link>
                    {s.domains[0] ? <span className="ml-2 text-xs text-muted-foreground">{s.domains[0]}</span> : null}
                  </td>
                  <td className="p-2">{t(`modes.${s.mode}`)}</td>
                  <td className="p-2">{t(`policies.${s.inventoryPolicy}`)}</td>
                  <td className="p-2 font-mono text-xs">{s.referencePrefix ?? '—'}</td>
                  <td className="p-2 font-mono text-xs uppercase">{s.locales.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/websites', query: { cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('next')}
        </Link>
      ) : null}
    </div>
  );
}
