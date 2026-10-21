import type { FeedPauseDto, FeedRunState } from '@inmolink/contracts';
import { Button } from '@inmolink/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { resumeFeedAction } from './actions';

/** Shared bits of the feed imports pages (S6-01). Server components only. */

type ImportsT = Awaited<ReturnType<typeof getTranslations<'imports'>>>;

const NOTICE_ERRORS = [
  'FORBIDDEN',
  'FEED_RUN_ACTIVE',
  'FEED_CONNECTION_DISABLED',
  'FEED_CONNECTION_PAUSED',
  'FEED_CONNECTION_NOT_FOUND',
  'VALIDATION_FAILED',
  'FEED_URL_NOT_ALLOWED',
  'VERSION_CONFLICT',
  'FEED_CONNECTOR_UNKNOWN',
  'FEED_MAPPING_REQUIRED',
  'FEED_MAPPING_INVALID',
  'FEED_MAPPING_PROFILE_NOT_FOUND',
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

/**
 * The agency notice of a feed the anomaly guard paused (S6-08): what it saw, that nothing was withdrawn or written
 * past the spike, and the resume form (admins; the API refuses others) with "accept the change".
 */
export async function PauseNotice({ connectionId, pause }: { connectionId: string; pause: FeedPauseDto }) {
  const t = await getTranslations('imports');
  const format = await getFormatter();
  const d = pause.details;
  const what =
    pause.reason === 'VOLUME_SPIKE'
      ? t('paused.VOLUME_SPIKE', { items: format.number(d.items ?? 0), typical: format.number(d.typical ?? 0) })
      : pause.reason === 'EMPTY_FEED'
        ? t('paused.EMPTY_FEED', { items: format.number(d.items ?? 0), live: format.number(d.live ?? 0) })
        : t('paused.MASS_WITHDRAWAL', {
            missing: format.number(d.missing ?? 0),
            live: format.number(d.live ?? 0),
          });
  return (
    <section
      role="alert"
      aria-labelledby="feed-paused"
      className="flex flex-col gap-2 rounded-md border border-amber-400 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50"
      data-testid="feed-paused"
    >
      <h2 id="feed-paused" className="font-semibold">
        {t('paused.title', { date: format.dateTime(new Date(pause.at), { dateStyle: 'medium', timeStyle: 'short' }) })}
      </h2>
      <p>{what}</p>
      <p>{t(`paused.explain.${pause.reason}`)}</p>
      <form action={resumeFeedAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="connectionId" value={connectionId} />
        <label className="flex items-center gap-2">
          <input type="checkbox" name="acceptChange" />
          {t('paused.acceptChange')}
        </label>
        <Button type="submit" size="sm">
          {t('paused.resume')}
        </Button>
      </form>
      <p className="text-xs">{t('paused.adminOnly')}</p>
    </section>
  );
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
  if (done === 'created' || done === 'saved' || done === 'resumed') {
    return (
      <p role="status" className="rounded-md border bg-muted p-3 text-sm">
        {t(`notices.${done}`)}
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
