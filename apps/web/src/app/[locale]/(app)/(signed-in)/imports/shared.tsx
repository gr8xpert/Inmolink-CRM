import type { FeedRunState } from '@inmolink/contracts';
import { getTranslations } from 'next-intl/server';

/** Shared bits of the feed imports pages (S6-01). Server components only. */

type ImportsT = Awaited<ReturnType<typeof getTranslations<'imports'>>>;

const NOTICE_ERRORS = [
  'FORBIDDEN',
  'FEED_RUN_ACTIVE',
  'FEED_CONNECTION_DISABLED',
  'FEED_CONNECTION_NOT_FOUND',
  'VALIDATION_FAILED',
] as const;

export function scheduleLabel(t: ImportsT, minutes: number | null): string {
  if (minutes === null) return t('scheduleManual');
  return minutes % 60 === 0 ? t('scheduleEvery', { hours: minutes / 60 }) : t('scheduleEveryMinutes', { minutes });
}

const STATE_STYLES: Record<FeedRunState, string> = {
  QUEUED: 'bg-muted text-muted-foreground',
  RUNNING: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100',
  SUCCEEDED: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100',
  FAILED: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100',
};

export function StateBadge({ state, label }: { state: FeedRunState; label: string }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_STYLES[state]}`}>{label}</span>;
}

/** The notice or error a "run now" form came back with (`?done=` / `?error=`). */
export async function ImportNotice({ done, error }: { done?: string; error?: string }) {
  const t = await getTranslations('imports');
  if (done === 'queued') {
    return (
      <p role="status" className="rounded-md border bg-muted p-3 text-sm">
        {t('notices.queued')}
      </p>
    );
  }
  if (!error) return null;
  const code = NOTICE_ERRORS.find((c) => c === error);
  return (
    <p role="alert" className="text-sm text-destructive">
      {code ? t(`errors.${code}`) : t('errors.generic')}
    </p>
  );
}
