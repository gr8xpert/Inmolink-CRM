import {
  NOTIFICATION_LIMITS,
  REALTIME_NOTIFICATION_EVENT,
  REALTIME_NOTIFICATIONS_NAMESPACE,
} from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { Link } from '@/i18n/navigation';
import { UnreadBadge } from './unread-badge';

/**
 * Notifications entry point (S1-10, live since S12-F1): a button that opens a panel through the HTML popover API — no
 * client JavaScript for opening, Escape and outside clicks close it, and the browser exposes the expanded state. The
 * badge is a small client island that follows new notifications over the realtime socket; the panel links to the full
 * feed and the notification settings at `/notifications`.
 */
export function NotificationsBell({
  labels,
  unread,
  realtimeUrl,
}: {
  labels: { open: string; title: string; empty: string; emptyBody: string; viewAll: string; unread: string };
  unread: { count: number; capped: boolean } | null;
  realtimeUrl: string | null;
}) {
  return (
    <>
      <button
        type="button"
        popoverTarget="notifications-panel"
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="sr-only">{labels.open}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        <UnreadBadge
          initial={unread}
          realtimeUrl={realtimeUrl}
          unreadLabel={labels.unread}
          socket={{
            namespace: REALTIME_NOTIFICATIONS_NAMESPACE,
            event: REALTIME_NOTIFICATION_EVENT,
            cap: NOTIFICATION_LIMITS.unreadCap,
          }}
        />
      </button>
      <section
        id="notifications-panel"
        popover="auto"
        aria-labelledby="notifications-title"
        className="fixed inset-auto top-16 right-4 m-0 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-background p-4 text-foreground shadow-lg"
      >
        <h2 id="notifications-title" className="mb-3 text-sm font-semibold">
          {labels.title}
        </h2>
        {unread === null || (unread.count === 0 && !unread.capped) ? (
          <EmptyState title={labels.empty} description={labels.emptyBody} />
        ) : (
          <p className="text-sm">
            {labels.unread.replace(
              '{count}',
              unread.capped ? `${NOTIFICATION_LIMITS.unreadCap}+` : String(unread.count),
            )}
          </p>
        )}
        <Link href="/notifications" className="mt-3 inline-block text-sm underline underline-offset-4">
          {labels.viewAll}
        </Link>
      </section>
    </>
  );
}
