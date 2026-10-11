import { VerificationRequestParams } from '@inmolink/contracts';
import { Button, Label } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchVerificationRequest, sessionRef } from '@/server/api';
import { decideAction, openDocumentAction } from '../actions';

const ERRORS = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VERIFICATION_STALE',
  'VERIFICATION_NOT_OPEN',
  'VALIDATION_FAILED',
  'generic',
] as const;
const NOTICES = ['APPROVE', 'REJECT'] as const;

/**
 * One verification request (S1-03): the agency's current details and documents, and the decision
 * form. The decision is bound to the details version shown here (`agencyVersion`).
 */
export default async function VerificationRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const id = VerificationRequestParams.safeParse({ id: (await params).id });
  if (!id.success) notFound();
  const res = await fetchVerificationRequest(sessionRef(session.user), id.data.id);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && (res.status === 403 || res.status === 404)) notFound();
  const t = await getTranslations('staff');
  const tv = await getTranslations('verification');
  const format = await getFormatter();
  const query = await searchParams;
  const notice = NOTICES.find((n) => n === query.notice);
  const error = ERRORS.find((e) => e === query.error);

  if (!res.ok) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      </main>
    );
  }
  const r = res.data;
  const a = r.agency;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <Link href="/staff/verification" className="text-sm underline-offset-4 hover:underline">
        {t('request.back')}
      </Link>
      <h1 className="text-xl font-semibold">{t('request.title', { agency: a.name })}</h1>
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

      <section aria-labelledby="details-heading" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
        <h2 id="details-heading" className="font-medium">
          {t('request.details', { version: a.version })}
        </h2>
        {r.detailsVersion !== a.version ? (
          <p className="rounded-md bg-muted p-2">{t('request.changedSince', { submitted: r.detailsVersion })}</p>
        ) : null}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{t('request.kind')}</dt>
          <dd>{a.kind}</dd>
          <dt className="text-muted-foreground">{t('request.taxId')}</dt>
          <dd>{a.taxId ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('request.address')}</dt>
          <dd>{[a.addressLine, a.postalCode, a.city].filter(Boolean).join(', ') || '—'}</dd>
          <dt className="text-muted-foreground">{t('request.region')}</dt>
          <dd>{a.region ?? '—'}</dd>
          <dt className="text-muted-foreground">{t('request.languages')}</dt>
          <dd>{a.languages.join(', ')}</dd>
        </dl>
      </section>

      <section aria-labelledby="docs-heading" className="flex flex-col gap-2">
        <h2 id="docs-heading" className="font-medium">
          {t('request.documents')}
        </h2>
        <ul className="divide-y rounded-md border">
          {r.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{d.fileName}</p>
                <p className="text-xs text-muted-foreground">
                  {tv(`kinds.${d.kind}`)} · {d.contentType}
                </p>
              </div>
              <form action={openDocumentAction} target="_blank" rel="noopener">
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="documentId" value={d.id} />
                <Button type="submit" variant="outline" size="sm">
                  {t('request.download')}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      {r.status === 'SUBMITTED' ? (
        <form action={decideAction} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={r.id} />
          <input type="hidden" name="agencyVersion" value={a.version} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="reason">{t('request.reason')}</Label>
            <textarea
              id="reason"
              name="reason"
              required
              minLength={3}
              maxLength={1000}
              rows={3}
              className="rounded-md border bg-background p-2 text-sm"
            />
          </div>
          <div className="flex gap-3">
            <Button type="submit" name="decision" value="APPROVE">
              {t('request.approve')}
            </Button>
            <Button type="submit" name="decision" value="REJECT" variant="outline">
              {t('request.reject')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="rounded-md bg-muted p-3 text-sm" data-testid="verification-decision">
          {t('request.decided', {
            status: t(`queue.tabs.${r.status}`),
            date: r.decidedAt ? format.dateTime(new Date(r.decidedAt), { dateStyle: 'medium' }) : '—',
            reason: r.decisionReason ?? '',
          })}
        </p>
      )}
    </main>
  );
}
