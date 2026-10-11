import { VERIFICATION_DOCUMENT_TYPES, VerificationDocumentKind } from '@inmolink/contracts';
import { Button, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchVerification, sessionRef } from '@/server/api';
import { removeAction, submitAction } from './actions';

const NOTICES = ['uploaded', 'removed', 'submitted'] as const;
const ERRORS = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'AGENCY_NOT_ONBOARDED',
  'VERIFICATION_ALREADY_SUBMITTED',
  'VERIFICATION_DOCUMENTS_REQUIRED',
  'VERIFICATION_NOT_OPEN',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_LIMIT_REACHED',
  'DOCUMENT_LOCKED',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'generic',
] as const;

/** Verification (S1-03): upload documents, send them with the company details, see staff's decision. Admins only. */
export default async function VerificationPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const res = await fetchVerification(sessionRef(session.user));
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('verification');
  const format = await getFormatter();
  const params = await searchParams;
  const notice = NOTICES.find((n) => n === params.notice);
  const error = ERRORS.find((e) => e === params.error);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  if (!res.ok) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.FORBIDDEN') : t('errors.generic')}
        </p>
      </main>
    );
  }
  const v = res.data;
  const latest = v.latestRequest;
  const waiting = latest?.status === 'SUBMITTED';
  const open = v.agencyStatus === 'PENDING' && v.onboarded && !waiting;
  const unsent = v.documents.filter((d) => !d.submitted);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`notices.${notice}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <section className="flex flex-col gap-2 rounded-md border p-4 text-sm" data-testid="verification-status">
        <p className="font-medium">{t(`status.${v.agencyStatus}`)}</p>
        {v.agencyStatus === 'VERIFIED' ? <p>{t('verifiedBody')}</p> : <p>{t('intro')}</p>}
        {latest ? (
          <p>{t(`requestStatus.${latest.status}`, { date: date(latest.decidedAt ?? latest.submittedAt) })}</p>
        ) : null}
        {latest?.status === 'REJECTED' && latest.decisionReason ? (
          <p className="rounded-md bg-muted p-2">{t('rejectedReason', { reason: latest.decisionReason })}</p>
        ) : null}
        {!v.onboarded ? (
          <p>
            {t('onboardingFirst')}{' '}
            <Link href="/onboarding" className="font-medium underline-offset-4 hover:underline">
              {t('goToOnboarding')}
            </Link>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="documents-heading" className="flex flex-col gap-2">
        <h2 id="documents-heading" className="font-medium">
          {t('documents')}
        </h2>
        {v.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noDocuments')}</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="verification-documents">
            {v.documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{d.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`kinds.${d.kind}`)} · {format.number(d.sizeBytes / 1024, { maximumFractionDigits: 0 })} KB
                  </p>
                </div>
                {d.submitted ? (
                  <span className="rounded-full bg-muted px-3 py-1 text-xs">{t('submittedBadge')}</span>
                ) : (
                  <form action={removeAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <Button type="submit" variant="outline" size="sm">
                      {t('remove')}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {open ? (
        <>
          <section aria-labelledby="upload-heading" className="flex flex-col gap-3">
            <h2 id="upload-heading" className="font-medium">
              {t('upload.title')}
            </h2>
            {/* A route handler, not a server action: only this path accepts 10 MB bodies. */}
            <form
              action="/api/verification/documents"
              method="post"
              encType="multipart/form-data"
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <input type="hidden" name="locale" value={locale} />
              <div className="flex flex-col gap-2">
                <Label htmlFor="doc-kind">{t('upload.kind')}</Label>
                <select
                  id="doc-kind"
                  name="kind"
                  defaultValue="TAX_ID"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  {VerificationDocumentKind.options.map((k) => (
                    <option key={k} value={k}>
                      {t(`kinds.${k}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor="doc-file">{t('upload.file')}</Label>
                <input
                  id="doc-file"
                  name="file"
                  type="file"
                  required
                  accept={VERIFICATION_DOCUMENT_TYPES.join(',')}
                  className="text-sm"
                />
              </div>
              <Button type="submit">{t('upload.submit')}</Button>
            </form>
          </section>

          <section aria-labelledby="submit-heading" className="flex flex-col gap-2">
            <h2 id="submit-heading" className="font-medium">
              {t('submit.title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('submit.body')}</p>
            <form action={submitAction}>
              <input type="hidden" name="version" value={v.agencyVersion} />
              <Button type="submit" disabled={unsent.length === 0}>
                {t('submit.action')}
              </Button>
            </form>
          </section>
        </>
      ) : null}
    </main>
  );
}
