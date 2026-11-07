import { randomUUID } from 'node:crypto';
import { FORM_SIGNER_ROLES, SIGNED_PDF_VERIFY_MAX_BYTES } from '@inmolink/contracts';
import { Button } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { OpenFileForm } from '@/components/open-file-form';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchContact } from '@/server/contacts-api';
import { fetchForm, fetchSignatureRequests } from '@/server/forms-api';
import { inClientMode, isActingAsMember } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { ActionButton } from '../../collaborations/action-button';
import { contactName } from '../../contacts/lookup';
import { openFormAction, openSignedAction, sendForSignatureAction } from '../actions';
import { PlaceholderNotice, RequestOptions, RequestTimeline, type SignerPrefill, SignerRows, type T } from '../parts';
import { errorKey, errorOf, formNoticeOf, isUuid, reasonOf } from '../query';

const SECTION = 'flex flex-col gap-3 rounded-md border p-4';
const VERIFY_RESULTS = ['SIGNED', 'ORIGINAL', 'NONE'] as const;

/**
 * One form (R2-05c): its state, language, version and the stored PDF's SHA-256, the download (a short signed link; none
 * while staff act as the member), its signing requests with each signer's timeline and the signed PDF, a check of any
 * PDF against the request's hashes, and — while it is READY and nobody signed it yet — the send-for-signature form,
 * prefilled with the client and the member. The collaboration agreement is sent from its deal room (both parties'
 * signers). The signing parts show only while `documents.esign` is on (the API answers ESIGN_NOT_ENABLED otherwise).
 */
export default async function FormPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const acting = shell ? isActingAsMember(shell.identity) : false;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ref = sessionRef(session.user);
  const [res, requests] = await Promise.all([fetchForm(ref, id), fetchSignatureRequests(ref, id)]);
  if (res === 'revoked' || requests === 'revoked') redirect('/session/expired');
  if (!res.ok && (res.status === 404 || res.error?.code === 'FORM_DOCUMENT_NOT_FOUND')) notFound();

  const tt = await getTranslations('documents.dashboard');
  const t: T = (key, values) => tt(key as never, values as never);
  const format = await getFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const q = await searchParams;
  const done = formNoticeOf(q.done);
  const error = errorOf(q.error);
  const reason = reasonOf(q.reason);
  const back = (
    <Link href="/forms" className="text-sm underline-offset-4 hover:underline">
      {t('back')}
    </Link>
  );
  if (!res.ok) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorKey(errorOf(res.error?.code) ?? 'generic', null)}`)}
        </p>
      </div>
    );
  }
  const f = res.data;
  const esign = requests.ok;
  const items = requests.ok ? requests.data.items : [];
  const signed = items.some((r) => r.status === 'SIGNED' || r.status === 'COMPLETED');
  const open = items.find((r) => r.status === 'OPEN');
  // the request a signed PDF is checked against: the completed one (a later request may have cancelled itself because
  // an earlier one got signed first), else the newest
  const latest = items.find((r) => r.status === 'COMPLETED') ?? items[0];
  const collaboration = f.template === 'COLLABORATION_AGREEMENT';
  const canSend = esign && f.status === 'READY' && !signed && !acting && !collaboration;

  // the send form's prefill: the client (the form's contact) and the member signing for the agency
  const prefill: SignerPrefill[] = [];
  if (canSend) {
    const roles = FORM_SIGNER_ROLES[f.template];
    const clientRole = roles.find((r) => r !== 'agency');
    if (clientRole && f.contactId) {
      const c = await fetchContact(ref, f.contactId);
      if (c === 'revoked') redirect('/session/expired');
      if (c.ok) {
        const name = contactName({ ...c.data, primaryEmail: null, primaryPhone: null });
        prefill.push({ name: name ?? '', email: c.data.emails[0] ?? '', role: clientRole });
      }
    }
    if (shell && roles.includes('agency')) prefill.push({ ...shell.user, role: 'agency' });
  }
  const verified = VERIFY_RESULTS.find((v) => v === q.verified) ?? null;
  const verifiedSha = typeof q.sha === 'string' && /^[0-9a-f]{64}$/.test(q.sha) ? q.sha : null;
  const formField = <input type="hidden" name="formId" value={f.id} />;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      {back}
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t(`templates.${f.template}`)}</h1>
        <p className="break-words text-sm text-muted-foreground">{f.label}</p>
      </header>
      {f.placeholder ? <PlaceholderNotice t={t} /> : null}
      {done ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`done.${done}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorKey(error, reason)}`)}
        </p>
      ) : null}
      {acting ? <p className="text-sm text-muted-foreground">{t('actingReadOnly')}</p> : null}

      <section aria-labelledby="h-document" className={SECTION}>
        <h2 id="h-document" className="text-base font-semibold">
          {t('detail.document')}
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('detail.status')}</dt>
          <dd>{t(`statuses.${f.status}`)}</dd>
          <dt className="text-muted-foreground">{t('detail.language')}</dt>
          <dd>{f.locale === 'es' ? t('languages.es') : f.locale === 'en' ? t('languages.en') : f.locale}</dd>
          <dt className="text-muted-foreground">{t('detail.version')}</dt>
          <dd>{f.templateVersion}</dd>
          <dt className="text-muted-foreground">{t('detail.created')}</dt>
          <dd>{date(f.createdAt)}</dd>
          {f.renderedAt ? (
            <>
              <dt className="text-muted-foreground">{t('detail.rendered')}</dt>
              <dd>{date(f.renderedAt)}</dd>
            </>
          ) : null}
          {f.sizeBytes !== null ? (
            <>
              <dt className="text-muted-foreground">{t('detail.size')}</dt>
              <dd>{`${format.number(Math.ceil(f.sizeBytes / 1024))} KB`}</dd>
            </>
          ) : null}
          {f.sha256 ? (
            <>
              <dt className="text-muted-foreground">{t('detail.hash')}</dt>
              <dd className="break-all font-mono text-xs" data-testid="form-hash">
                {f.sha256}
              </dd>
            </>
          ) : null}
        </dl>
        {f.status === 'PENDING' ? <p className="text-sm text-muted-foreground">{t('detail.pending')}</p> : null}
        {f.status === 'FAILED' ? <p className="text-sm text-destructive">{t('detail.failed')}</p> : null}
        {f.status === 'READY' && f.url ? (
          <OpenFileForm action={openFormAction}>
            {formField}
            <Button type="submit" variant="outline" size="sm">
              {t('detail.download')}
            </Button>
          </OpenFileForm>
        ) : null}
        {f.dealId ? (
          <Link href={`/deals/${f.dealId}`} className="self-start text-sm underline-offset-4 hover:underline">
            {t('detail.openDeal')}
          </Link>
        ) : null}
      </section>

      {esign ? (
        <section aria-labelledby="h-signatures" className={SECTION}>
          <h2 id="h-signatures" className="text-base font-semibold">
            {t('sign.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('sign.intro')}</p>
          {items.length === 0 ? <p className="text-sm text-muted-foreground">{t('sign.none')}</p> : null}
          {items.map((r) => (
            <div key={r.id} className="flex flex-col gap-2 rounded-md bg-muted/40 p-3">
              <RequestTimeline request={r} t={t} date={date} />
              {r.status === 'COMPLETED' && r.url ? (
                <OpenFileForm action={openSignedAction}>
                  {formField}
                  <input type="hidden" name="requestId" value={r.id} />
                  <Button type="submit" variant="outline" size="sm">
                    {t('requests.downloadSigned')}
                  </Button>
                </OpenFileForm>
              ) : null}
            </div>
          ))}

          {latest ? (
            // A route handler, not a server action: only that path accepts a 25 MB body.
            <form
              action={`/api/forms/${f.id}/verify`}
              method="post"
              encType="multipart/form-data"
              className="flex flex-col gap-2 border-t pt-3 text-sm"
            >
              <h3 className="font-medium">{t('verify.title')}</h3>
              <p className="text-muted-foreground">{t('verify.intro')}</p>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="requestId" value={latest.id} />
              <label className="flex flex-col gap-1">
                <span>{t('verify.file', { max: String(SIGNED_PDF_VERIFY_MAX_BYTES / 1024 / 1024) })}</span>
                <input type="file" name="file" required accept="application/pdf,.pdf" className="text-sm" />
              </label>
              <div>
                <Button type="submit" variant="outline" size="sm">
                  {t('verify.submit')}
                </Button>
              </div>
              {verified ? (
                <p
                  role="status"
                  data-testid="verify-result"
                  className={`rounded-md p-2 ${verified === 'NONE' ? 'bg-destructive/10 text-destructive' : 'bg-muted'}`}
                >
                  {t(`verify.results.${verified}`)}
                  {verifiedSha ? <span className="block break-all font-mono text-xs">{verifiedSha}</span> : null}
                </p>
              ) : null}
            </form>
          ) : null}

          {collaboration && f.dealId && !signed ? (
            <p className="text-sm text-muted-foreground">
              {t('sign.fromDeal')}{' '}
              <Link href={`/deals/${f.dealId}`} className="underline-offset-4 hover:underline">
                {t('detail.openDeal')}
              </Link>
            </p>
          ) : null}
          {esign && !signed && f.status !== 'READY' ? (
            <p className="text-sm text-muted-foreground">{t('sign.readyOnly')}</p>
          ) : null}
          {canSend ? (
            <form action={sendForSignatureAction} className="flex flex-col gap-3 border-t pt-3 text-sm">
              <h3 className="font-medium">{t('sign.send')}</h3>
              {formField}
              <input type="hidden" name="template" value={f.template} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <SignerRows roles={FORM_SIGNER_ROLES[f.template]} prefill={prefill} rows={4} t={t} />
              <RequestOptions t={t} />
              {open ? <p className="text-muted-foreground">{t('sign.supersedes')}</p> : null}
              <div>
                <ActionButton variant="default" label={t('sign.submit')} confirm={t('sign.confirm')} />
              </div>
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
