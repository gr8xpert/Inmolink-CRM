import { NOTIFICATION_TYPES } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchNotificationPreferences, fetchNotifications, fetchUnreadCount } from '@/server/notifications-api';
import { markAllReadAction, markReadAction, savePreferenceAction } from './actions';
import { notificationHref } from './link';

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const ERRORS = ['generic', 'VALIDATION_FAILED', 'FORBIDDEN', 'RATE_LIMITED'] as const;
const DONE = ['read', 'readAll', 'saved'] as const;

/**
 * Notifications (S12-F1, PLAN §7 M12): the member's feed (all or unread), mark read, and the preferences per type —
 * on/off, in the app, e-mail summary. A type switched off is not raised at all (the API checks it when it is created).
 */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const q = await searchParams;
  const unreadOnly = q.unread === '1';
  const cursor = q.cursor && CURSOR.test(q.cursor) ? q.cursor : undefined;
  const done = DONE.find((d) => d === q.done);
  const error = ERRORS.find((e) => e === q.error);
  const t = await getTranslations('notifications');
  const format = await getFormatter();
  const ref = sessionRef(session.user);
  const [feed, count, prefs] = await Promise.all([
    fetchNotifications(ref, { limit: 25, cursor, unread: unreadOnly }),
    fetchUnreadCount(ref),
    fetchNotificationPreferences(ref),
  ]);
  if (feed === 'revoked' || count === 'revoked' || prefs === 'revoked') redirect('/session/expired');
  const byType = new Map((prefs.ok ? prefs.data.items : []).map((p) => [p.type, p]));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {count.ok ? (
          <span className="text-sm text-muted-foreground" data-testid="unread-count">
            {count.data.capped ? t('unreadCapped') : t('unread', { count: count.data.count })}
          </span>
        ) : null}
      </div>
      {done ? (
        <p role="status" className="text-sm text-green-700">
          {t(`done.${done}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <nav aria-label={t('title')} className="flex flex-wrap items-center gap-4 text-sm">
        <Link
          href="/notifications"
          aria-current={unreadOnly ? undefined : 'page'}
          className={unreadOnly ? 'underline-offset-4 hover:underline' : 'font-semibold underline underline-offset-4'}
        >
          {t('filters.all')}
        </Link>
        <Link
          href={{ pathname: '/notifications', query: { unread: '1' } }}
          aria-current={unreadOnly ? 'page' : undefined}
          className={unreadOnly ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'}
        >
          {t('filters.unread')}
        </Link>
        <form action={markAllReadAction} className="ml-auto">
          <button type="submit" className="h-8 rounded-md border px-3">
            {t('markAllRead')}
          </button>
        </form>
      </nav>

      {!feed.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.load')}
        </p>
      ) : feed.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="divide-y rounded-md border">
          {feed.data.items.map((n) => {
            const href = notificationHref(n.link);
            const message = t(`types.${n.type}`, {
              actor: '',
              subject: '',
              count: 0,
              refs: '',
              ...n.params,
            });
            return (
              <li key={n.id} data-testid="notification" className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <div className="flex min-w-60 flex-1 flex-col">
                  <span className={n.readAt ? '' : 'font-semibold'}>
                    {href ? (
                      <Link href={href} className="underline-offset-4 hover:underline">
                        {message}
                      </Link>
                    ) : (
                      message
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {format.dateTime(new Date(n.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </div>
                {n.readAt ? null : (
                  <form action={markReadAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="createdAt" value={n.createdAt} />
                    <button type="submit" className="h-8 rounded-md border px-3">
                      {t('markRead')}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {feed.ok && feed.data.nextCursor ? (
        <Link
          href={{
            pathname: '/notifications',
            query: { cursor: feed.data.nextCursor, ...(unreadOnly ? { unread: '1' } : {}) },
          }}
          className="text-sm underline underline-offset-4"
        >
          {t('loadMore')}
        </Link>
      ) : null}

      <section aria-labelledby="notification-prefs" className="flex flex-col gap-3">
        <h2 id="notification-prefs" className="font-medium">
          {t('preferences.title')}
        </h2>
        <ul className="divide-y rounded-md border">
          {NOTIFICATION_TYPES.map((type) => {
            const p = byType.get(type) ?? { enabled: true, inApp: true, email: true };
            return (
              <li key={type}>
                <form
                  action={savePreferenceAction}
                  data-testid={`pref-${type}`}
                  className="flex flex-wrap items-center gap-4 p-3 text-sm"
                >
                  <input type="hidden" name="type" value={type} />
                  <span className="min-w-60 flex-1 font-medium">{t(`typeLabels.${type}`)}</span>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" name="enabled" defaultChecked={p.enabled} />
                    {t('preferences.enabled')}
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" name="inApp" defaultChecked={p.inApp} />
                    {t('preferences.inApp')}
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" name="email" defaultChecked={p.email} />
                    {t('preferences.email')}
                  </label>
                  <button type="submit" className="h-8 rounded-md border px-3">
                    {t('preferences.save')}
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
