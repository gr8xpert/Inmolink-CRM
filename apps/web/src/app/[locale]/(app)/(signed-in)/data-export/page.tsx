import { randomUUID } from 'node:crypto';
import { DataExportFormat, DataExportKind } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchDataExports } from '@/server/contacts-api';
import { downloadExportAction, requestExportAction } from './actions';

const FAILURES: readonly string[] = ['TOO_LARGE', 'TIMEOUT', 'INTERNAL'];
const ERRORS = [
  'generic',
  'MFA_CODE_INVALID',
  'VALIDATION_FAILED',
  'DATA_EXPORT_IN_PROGRESS',
  'DATA_EXPORT_NOT_FOUND',
  'FORBIDDEN',
  'RATE_LIMITED',
] as const;

/**
 * Data export (S11-F14, PLAN §3 #59 "you can always leave"): admins request their contacts, leads, listings or the
 * whole account, with a fresh authenticator code every time (verified by the API), follow the recent exports and get a
 * short-lived signed link for a finished one. The link is a POST action per export (it is audited): the browser is sent
 * straight to the signed URL, which is never rendered into a page.
 */
export default async function DataExportPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const ref = sessionRef(session.user);
  const t = await getTranslations('data-export');
  const format = await getFormatter();
  const list = await fetchDataExports(ref);
  if (list === 'revoked') redirect('/session/expired');
  const error = params.error
    ? (ERRORS as readonly string[]).includes(params.error)
      ? (params.error as (typeof ERRORS)[number])
      : 'generic'
    : null;
  const forbidden = !list.ok && list.status === 403;
  const field = 'h-9 rounded-md border bg-background px-2';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {params.done ? (
        <p role="status" className="text-sm">
          {t('done')}
        </p>
      ) : null}
      {error || forbidden ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${forbidden ? 'FORBIDDEN' : (error as 'generic')}`)}
        </p>
      ) : null}

      {forbidden ? null : (
        <form action={requestExportAction} className="flex flex-wrap items-end gap-3 rounded-md border p-3 text-sm">
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label className="flex flex-col gap-1">
            <span>{t('form.kind')}</span>
            <select name="kind" className={field}>
              {DataExportKind.options.map((v) => (
                <option key={v} value={v}>
                  {t(`kinds.${v}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('form.format')}</span>
            <select name="format" className={field}>
              {DataExportFormat.options.map((v) => (
                <option key={v} value={v}>
                  {t(`formats.${v}`)}
                </option>
              ))}
            </select>
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
          <p id="code-hint" className="basis-full text-xs text-muted-foreground">
            {t('form.codeHint')}
          </p>
        </form>
      )}

      {forbidden ? null : (
        <section aria-labelledby="recent" className="flex flex-col gap-2">
          <h2 id="recent" className="text-base font-semibold">
            {t('list.title')}
          </h2>
          {!list.ok ? (
            <p role="alert" className="text-sm text-destructive">
              {t('errors.load')}
            </p>
          ) : list.data.items.length === 0 ? (
            <EmptyState title={t('list.empty')} />
          ) : (
            <ul className="divide-y rounded-md border" data-testid="export-list">
              {list.data.items.map((e) => {
                const rows = Object.values(e.counts).reduce((a, b) => a + b, 0);
                return (
                  <li key={e.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                    <div className="flex min-w-60 flex-1 flex-col">
                      <span className="font-medium">
                        {t(`kinds.${e.kind}`)} · {t(`formats.${e.format}`)}
                      </span>
                      <span className="text-muted-foreground">
                        {t('list.requested', {
                          date: format.dateTime(new Date(e.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
                        })}
                        {e.status === 'SUCCEEDED' ? ` · ${t('list.rows', { count: rows })}` : ''}
                        {e.errorCode
                          ? ` · ${t(`failure.${FAILURES.includes(e.errorCode) ? e.errorCode : 'INTERNAL'}`)}`
                          : ''}
                      </span>
                    </div>
                    <span className="rounded-md border px-2 py-0.5 text-xs">{t(`status.${e.status}`)}</span>
                    {e.status === 'SUCCEEDED' ? (
                      <form action={downloadExportAction}>
                        <input type="hidden" name="id" value={e.id} />
                        <button type="submit" className="h-8 rounded-md border px-3">
                          {t('list.download')}
                        </button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
