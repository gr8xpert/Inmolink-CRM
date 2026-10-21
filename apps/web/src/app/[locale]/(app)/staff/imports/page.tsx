import { type FeedPauseDto, IMPORT_RESUME_STAFF_ROLES, type ImportHealthDto } from '@inmolink/contracts';
import { Button, EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchImportHealth } from '@/server/staff-api';
import { staffResumeFeedAction } from './actions';

const ERRORS = ['FORBIDDEN', 'FEED_CONNECTION_NOT_FOUND', 'VALIDATION_FAILED'] as const;
const RESUMERS: ReadonlySet<string> = new Set(IMPORT_RESUME_STAFF_ROLES);

type StaffT = Awaited<ReturnType<typeof getTranslations<'staff'>>>;
type Formatter = Awaited<ReturnType<typeof getFormatter>>;

/**
 * Staff import health (S6-08): feed runs of the last 24 h (finished, failed, paused by the anomaly guard), failures
 * by code, queue lag, the connections the guard paused (data ops and super admins resume them) and the feed values
 * waiting for a taxonomy mapping. Every staff role may look.
 */
export default async function StaffImportsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session, me } = await requireStaff();
  const res = await fetchImportHealth(session);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const params = await searchParams;
  const error = params.error ? (ERRORS.find((c) => c === params.error) ?? 'generic') : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('imports.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('imports.intro')}</p>
      {params.notice === 'resumed' ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t('imports.resumed')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error === 'generic' ? t('errors.generic') : t(`imports.errors.${error}`)}
        </p>
      ) : null}
      {res.ok ? (
        <Health data={res.data} canResume={RESUMERS.has(me.role)} t={t} format={format} />
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function pauseText(t: StaffT, format: Formatter, pause: FeedPauseDto): string {
  const d = pause.details;
  if (pause.reason === 'VOLUME_SPIKE') {
    return t('imports.reasons.VOLUME_SPIKE', {
      items: format.number(d.items ?? 0),
      typical: format.number(d.typical ?? 0),
    });
  }
  if (pause.reason === 'EMPTY_FEED') {
    return t('imports.reasons.EMPTY_FEED', { items: format.number(d.items ?? 0), live: format.number(d.live ?? 0) });
  }
  return t('imports.reasons.MASS_WITHDRAWAL', {
    missing: format.number(d.missing ?? 0),
    live: format.number(d.live ?? 0),
  });
}

function Health({
  data,
  canResume,
  t,
  format,
}: {
  data: ImportHealthDto;
  canResume: boolean;
  t: StaffT;
  format: Formatter;
}) {
  const n = (v: number) => format.number(v);
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' });
  const duration = (s: number) =>
    s >= 3_600
      ? t('imports.hours', { n: Math.round(s / 360) / 10 })
      : s >= 60
        ? t('imports.minutes', { n: Math.round(s / 60) })
        : t('imports.seconds', { n: s });
  return (
    <>
      <section aria-labelledby="import-runs" className="flex flex-col gap-3">
        <h2 id="import-runs" className="text-lg font-semibold">
          {t('imports.window', { hours: data.windowHours })}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="import-health-runs">
          <Stat label={t('imports.runs.finished')} value={n(data.runs.finished)} />
          <Stat label={t('imports.runs.succeeded')} value={n(data.runs.succeeded)} />
          <Stat label={t('imports.runs.failed')} value={n(data.runs.failed)} />
          <Stat label={t('imports.runs.paused')} value={n(data.runs.paused)} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label={t('imports.lag.queued')} value={n(data.lag.queued)} />
          <Stat label={t('imports.lag.running')} value={n(data.lag.running)} />
          <Stat label={t('imports.lag.oldest')} value={duration(data.lag.oldestQueuedSeconds)} />
          <Stat label={t('imports.lag.p95')} value={duration(data.lag.p95WaitSeconds)} />
          <Stat label={t('imports.lag.max')} value={duration(data.lag.maxWaitSeconds)} />
        </div>
      </section>

      <section aria-labelledby="import-paused" className="flex flex-col gap-3">
        <h2 id="import-paused" className="text-lg font-semibold">
          {t('imports.pausedTitle')}
        </h2>
        {data.paused.length === 0 ? (
          <EmptyState title={t('imports.noPaused')} />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm" data-testid="paused-feeds">
              <thead className="bg-muted">
                <tr>
                  <th className="p-2">{t('imports.feed')}</th>
                  <th className="p-2">{t('imports.reason')}</th>
                  <th className="p-2">{t('imports.since')}</th>
                  <th className="p-2">
                    <span className="sr-only">{t('imports.resume')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.paused.map((p) => (
                  <tr key={p.connectionId}>
                    <td className="p-2">
                      {/* Agency data: rendered as text. */}
                      <span className="font-medium">{p.name}</span>{' '}
                      <span className="font-mono text-xs text-muted-foreground">{p.connector}</span>
                      <br />
                      <Link
                        href={`/staff/tenants/${p.agencyId}`}
                        className="text-xs underline-offset-4 hover:underline"
                      >
                        {t('imports.agency')}
                      </Link>
                    </td>
                    <td className="p-2">{pauseText(t, format, p.pause)}</td>
                    <td className="p-2 whitespace-nowrap">{when(p.pause.at)}</td>
                    <td className="p-2">
                      {canResume ? (
                        <form action={staffResumeFeedAction} className="flex flex-col items-end gap-1">
                          <input type="hidden" name="connectionId" value={p.connectionId} />
                          <label className="flex flex-col items-end gap-1 text-xs">
                            {t('imports.resumeReason')}
                            <textarea
                              name="reason"
                              required
                              minLength={10}
                              maxLength={500}
                              rows={2}
                              aria-describedby={`resume-hint-${p.connectionId}`}
                              className="w-56 rounded-md border bg-background p-1 text-xs"
                            />
                          </label>
                          <span id={`resume-hint-${p.connectionId}`} className="text-xs text-muted-foreground">
                            {t('imports.resumeReasonHint')}
                          </span>
                          <label className="flex items-center gap-1 text-xs">
                            <input type="checkbox" name="acceptChange" />
                            {t('imports.acceptChange')}
                          </label>
                          <Button type="submit" size="sm" variant="outline">
                            {t('imports.resume')}
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
      </section>

      <section aria-labelledby="import-failures" className="flex flex-col gap-3">
        <h2 id="import-failures" className="text-lg font-semibold">
          {t('imports.failuresTitle')}
        </h2>
        {data.failures.length === 0 ? (
          <EmptyState title={t('imports.noFailures')} />
        ) : (
          <ul className="flex flex-wrap gap-2 text-sm" data-testid="failure-codes">
            {data.failures.map((f) => (
              <li key={f.code} className="rounded border px-2 py-1">
                <span className="font-mono text-xs">{f.code}</span> · {n(f.count)}
              </li>
            ))}
          </ul>
        )}
        {data.recentFailures.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="p-2">{t('imports.finishedAt')}</th>
                  <th className="p-2">{t('imports.code')}</th>
                  <th className="p-2">{t('imports.connector')}</th>
                  <th className="p-2">{t('imports.agency')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.recentFailures.map((f) => (
                  <tr key={f.runId}>
                    <td className="p-2 whitespace-nowrap">{when(f.finishedAt)}</td>
                    <td className="p-2 font-mono text-xs">{f.errorCode}</td>
                    <td className="p-2 font-mono text-xs">{f.connector}</td>
                    <td className="p-2">
                      <Link href={`/staff/tenants/${f.agencyId}`} className="underline-offset-4 hover:underline">
                        {t('imports.open')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="import-unmatched" className="flex flex-col gap-3">
        <h2 id="import-unmatched" className="text-lg font-semibold">
          {t('imports.unmatchedTitle')}
        </h2>
        <div className="grid grid-cols-3 gap-3">
          <Stat label={t('imports.unmatched.location')} value={n(data.unmatched.location)} />
          <Stat label={t('imports.unmatched.propertyType')} value={n(data.unmatched.propertyType)} />
          <Stat label={t('imports.unmatched.feature')} value={n(data.unmatched.feature)} />
        </div>
        <Link href="/staff/taxonomy" className="text-sm font-medium underline-offset-4 hover:underline">
          {t('imports.mapValues')}
        </Link>
      </section>
    </>
  );
}
