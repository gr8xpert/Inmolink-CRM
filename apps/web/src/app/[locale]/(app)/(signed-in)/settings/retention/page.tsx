import { RETENTION_GRACE_DAYS, RETENTION_MAX_MONTHS, RETENTION_MIN_MONTHS } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchRetention } from '@/server/compliance-api';
import { saveRetentionAction } from './actions';
import { RetentionNotice, retentionView } from './retention-view';

const ERRORS = ['generic', 'MFA_CODE_INVALID', 'VALIDATION_FAILED', 'FORBIDDEN', 'RATE_LIMITED'] as const;

/**
 * Data retention (S16-F5, PLAN §13): the agency's period after which inactive contacts are anonymized for good by the
 * daily job (off by default). Admins change it with a fresh authenticator code (verified by the API). A shorter period
 * (or one newly turned on) applies only after the grace window: the page shows the period in force and the date the
 * new one starts to apply.
 */
export default async function RetentionPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const q = await searchParams;
  const res = await fetchRetention(sessionRef(session.user));
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('agency.retention');
  const format = await getFormatter();
  const error = q.error
    ? (ERRORS as readonly string[]).includes(q.error)
      ? (q.error as (typeof ERRORS)[number])
      : 'generic'
    : null;
  const forbidden = !res.ok && res.status === 403;
  const field = 'h-9 rounded-md border bg-background px-2';

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link href="/settings" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {q.saved ? (
        <p role="status" className="text-sm">
          {t('saved')}
        </p>
      ) : null}
      {error || forbidden ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${forbidden ? 'FORBIDDEN' : (error as 'generic')}`)}
        </p>
      ) : null}
      {!res.ok ? (
        forbidden ? null : (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.load')}
          </p>
        )
      ) : (
        <>
          <RetentionNotice
            view={retentionView(res.data, new Date())}
            formatDate={(d) => format.dateTime(d, { dateStyle: 'long' })}
            labels={{
              inForce: (months) => t('inForce', { months }),
              inForceOff: t('inForceOff'),
              pending: (months, date) => (months === null ? t('pendingOff', { date }) : t('pending', { months, date })),
              graceHint: t('graceHint'),
            }}
          />
          <form action={saveRetentionAction} className="flex flex-wrap items-end gap-3 rounded-md border p-3 text-sm">
            <label className="flex flex-col gap-1">
              <span>{t('form.months')}</span>
              <input
                type="number"
                name="months"
                min={RETENTION_MIN_MONTHS}
                max={RETENTION_MAX_MONTHS}
                step={1}
                defaultValue={res.data.inactiveContactMonths ?? ''}
                aria-describedby="months-hint"
                className={field}
              />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="off" defaultChecked={res.data.inactiveContactMonths === null} />
              <span>{t('form.off')}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span>{t('form.code')}</span>
              <input
                name="twoFactorCode"
                required
                autoComplete="one-time-code"
                inputMode="text"
                maxLength={16}
                aria-describedby="code-hint"
                className={field}
              />
            </label>
            <button type="submit" className="h-9 rounded-md border px-3 font-medium">
              {t('form.submit')}
            </button>
            <p id="months-hint" className="basis-full text-xs text-muted-foreground">
              {t('form.monthsHint', {
                min: RETENTION_MIN_MONTHS,
                max: RETENTION_MAX_MONTHS,
                days: RETENTION_GRACE_DAYS,
              })}
            </p>
            <p id="code-hint" className="basis-full text-xs text-muted-foreground">
              {t('form.codeHint')}
            </p>
          </form>
        </>
      )}
    </div>
  );
}
