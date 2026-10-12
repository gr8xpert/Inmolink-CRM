import { EmptyState } from '@inmolink/ui';

/**
 * Notifications entry point (S1-10, placeholder until the notifications feature): a button that opens
 * a panel through the HTML popover API — no client JavaScript, Escape and outside clicks close it, and
 * the browser exposes the expanded state. The panel says there is nothing yet.
 */
export function NotificationsBell({
  labels,
}: {
  labels: { open: string; title: string; empty: string; emptyBody: string };
}) {
  return (
    <>
      <button
        type="button"
        popoverTarget="notifications-panel"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <EmptyState title={labels.empty} description={labels.emptyBody} />
      </section>
    </>
  );
}
