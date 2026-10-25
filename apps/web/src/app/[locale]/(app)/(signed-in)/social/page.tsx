import type { SocialAccountDto, SocialPostDto } from '@inmolink/contracts';
import { Button, EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { agencyTimeZone } from '@/server/agency-time-zone';
import { sessionRef } from '@/server/api';
import { fetchSocialAccounts, fetchSocialPosts } from '@/server/social-api';
import { cancelPostAction, connectAccountsAction, disconnectAccountAction } from './actions';
import { SOCIAL_POST_ERRORS } from './errors';
import { SocialNotice } from './notice';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Social posting (S12-07): the agency's connected Facebook Pages and Instagram accounts (connect, reconnect, remove —
 * admins), and the history of its posts with their status and errors. Composing starts from a listing
 * (`/social/new?listingId=`). Behind the `social.posting` flag: the API answers SOCIAL_NOT_ENABLED otherwise.
 */
export default async function SocialPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const ref = sessionRef(session.user);
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const [accounts, posts] = await Promise.all([fetchSocialAccounts(ref), fetchSocialPosts(ref, cursor)]);
  if (accounts === 'revoked' || posts === 'revoked') redirect('/session/expired');
  const t = await getTranslations('social');
  const format = await getFormatter();
  const timeZone = await agencyTimeZone(ref);
  const postError = (code: string) => {
    const known = SOCIAL_POST_ERRORS.find((c) => c === code);
    return known ? t(`postErrors.${known}`) : code;
  };
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone }) : '—';

  if (!accounts.ok && accounts.error?.code === 'SOCIAL_NOT_ENABLED') {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <EmptyState title={t('notEnabled')} />
      </div>
    );
  }
  const accountName = new Map(
    (accounts.ok ? accounts.data.items : []).map((a: SocialAccountDto) => [a.id, a.name] as const),
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <SocialNotice done={params.done} error={params.error} />

      <section aria-labelledby="social-accounts" className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 id="social-accounts" className="font-medium">
            {t('accounts.title')}
          </h2>
          <form action={connectAccountsAction} className="ml-auto">
            <Button type="submit" size="sm">
              {t('accounts.connect')}
            </Button>
          </form>
        </div>
        {!accounts.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.generic')}
          </p>
        ) : accounts.data.items.length === 0 ? (
          <EmptyState title={t('accounts.empty')} />
        ) : (
          <ul className="divide-y rounded-md border" data-testid="social-accounts">
            {accounts.data.items.map((a: SocialAccountDto) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <span className="font-medium">{a.name}</span>
                <span className="text-muted-foreground">{t(`platforms.${a.platform}`)}</span>
                {a.status === 'NEEDS_RECONNECT' ? (
                  <span role="status" className="rounded bg-amber-100 px-2 py-0.5 text-amber-950">
                    {t('accounts.needsReconnect')}
                  </span>
                ) : null}
                <form action={disconnectAccountAction} className="ml-auto">
                  <input type="hidden" name="accountId" value={a.id} />
                  <Button type="submit" variant="outline" size="sm">
                    {t('accounts.disconnect')}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="social-posts" className="flex flex-col gap-3">
        <h2 id="social-posts" className="font-medium">
          {t('posts.title')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('posts.compose')}{' '}
          <Link href="/social/new" className="font-medium underline-offset-4 hover:underline">
            {t('posts.new')}
          </Link>
        </p>
        {!posts.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.generic')}
          </p>
        ) : posts.data.items.length === 0 ? (
          <EmptyState title={t('posts.empty')} />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm" data-testid="social-posts">
              <thead className="bg-muted">
                <tr>
                  <th className="p-2">{t('posts.columns.account')}</th>
                  <th className="p-2">{t('posts.columns.status')}</th>
                  <th className="p-2">{t('posts.columns.when')}</th>
                  <th className="p-2">{t('posts.columns.caption')}</th>
                  <th className="p-2">
                    <span className="sr-only">{t('posts.columns.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {posts.data.items.map((p: SocialPostDto) => (
                  <tr key={p.id}>
                    <td className="p-2">
                      {accountName.get(p.accountId) ?? '—'}
                      <span className="block text-xs text-muted-foreground">{t(`platforms.${p.platform}`)}</span>
                    </td>
                    <td className="p-2">
                      {t(`statuses.${p.status}`)}
                      {p.error ? (
                        <span className="block text-xs text-destructive">
                          {postError(p.error.code)}
                          {p.error.message ? ` — ${p.error.message}` : ''}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2 whitespace-nowrap">{when(p.publishedAt ?? p.scheduledAt)}</td>
                    <td className="max-w-xs truncate p-2">{p.caption ?? '—'}</td>
                    <td className="p-2">
                      {p.status === 'DRAFT' || p.status === 'SCHEDULED' ? (
                        <form action={cancelPostAction}>
                          <input type="hidden" name="postId" value={p.id} />
                          <input type="hidden" name="version" value={p.version} />
                          <Button type="submit" variant="ghost" size="sm">
                            {t('posts.cancel')}
                          </Button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {posts.ok && posts.data.nextCursor ? (
          <Link
            href={{ pathname: '/social', query: { cursor: posts.data.nextCursor } }}
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            {t('next')}
          </Link>
        ) : null}
      </section>
    </div>
  );
}
