import { randomUUID } from 'node:crypto';
import type {
  DealDto,
  DealSignerCandidate,
  DealSignersDto,
  FormDocumentDto,
  SignatureRequestDto,
} from '@inmolink/contracts';
import { UI_LOCALES } from '@inmolink/i18n';
import { Button } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { OpenFileForm } from '@/components/open-file-form';
import { Link } from '@/i18n/navigation';
import type { SessionRef } from '@/server/api';
import { fetchDealSigners, fetchForms, fetchSignatureRequests } from '@/server/forms-api';
import { ActionButton } from '../../collaborations/action-button';
import { createCollaborationAgreementAction, openFormAction, sendDealSignatureAction } from '../../forms/actions';
import { PlaceholderNotice, RequestOptions, RequestTimeline, type T } from '../../forms/parts';
import { errorKey, errorOf, formNoticeOf, reasonOf } from '../../forms/query';

const FIELD = 'h-9 rounded-md border bg-background px-2';

/** A request that holds the agreement: out for signature (OPEN, not expired: the API says EXPIRED) or signed. */
const LIVE = new Set<SignatureRequestDto['status']>(['OPEN', 'SIGNED', 'COMPLETED']);

function SignerSelect(props: { name: string; label: string; items: readonly DealSignerCandidate[]; t: T }) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span>{props.label}</span>
      <select name={props.name} required defaultValue={props.items[0]?.userId} className={FIELD}>
        {props.items.map((s) => (
          <option key={s.userId} value={s.userId}>
            {`${s.name} · ${s.email} · ${props.t(s.dealMember ? 'deal.dealMember' : 'deal.admin')}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface AgreementState {
  /** The deal's agreements, newest first; null when they could not be loaded. */
  forms: readonly FormDocumentDto[] | null;
  /** The newest agreement's requests; null while it is not READY or e-signature is off. */
  requests: readonly SignatureRequestDto[] | null;
  /** Who may sign for each party; null while e-signature is off (or the newest is not READY). */
  signers: DealSignersDto | null;
}

/**
 * The section itself (R2-05c), from what the loader read: the newest agreement (status, hash, download, signing
 * timeline), "generate" while none holds the deal (none yet, the newest FAILED, or READY with no live request — the API
 * refuses AGREEMENT_IN_SIGNATURE otherwise), and "send to both agencies" with one signer per party picked by user id.
 */
export function AgreementPanel({
  deal,
  state,
  locale,
  acting,
  query,
  t,
  date,
}: {
  deal: DealDto;
  state: AgreementState;
  locale: string;
  acting: boolean;
  query: Record<string, string | string[] | undefined>;
  t: T;
  date: (iso: string) => string;
}) {
  const latest = state.forms?.[0];
  const items = state.requests ?? [];
  const held = items.some((r) => LIVE.has(r.status));
  const signed = items.some((r) => r.status === 'SIGNED' || r.status === 'COMPLETED');
  const live = deal.stage !== 'FELL_THROUGH' && !acting;
  const canGenerate = live && (!latest || latest.status === 'FAILED' || (latest.status === 'READY' && !held));
  const signers = state.signers;
  const canSign = live && latest?.status === 'READY' && signers !== null && state.requests !== null && !signed;
  const counterpart = deal.counterpartName ?? t('deal.otherAgency');
  const done = formNoticeOf(query.formDone);
  const error = errorOf(query.formError);
  const reason = reasonOf(query.formReason);

  return (
    <section
      aria-labelledby="h-agreement"
      className="flex flex-col gap-3 rounded-md border p-4"
      data-testid="deal-agreement-section"
    >
      <h2 id="h-agreement" className="text-base font-semibold">
        {t('deal.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('deal.intro')}</p>
      {!latest || latest.placeholder ? <PlaceholderNotice t={t} /> : null}
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
      {state.forms === null ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.load')}
        </p>
      ) : null}

      {latest ? (
        <div className="flex flex-col gap-2 text-sm" data-testid="deal-agreement">
          <p>
            <Link href={`/forms/${latest.id}`} className="font-medium underline-offset-4 hover:underline">
              {latest.label}
            </Link>{' '}
            <span className="text-muted-foreground">
              · {t(`statuses.${latest.status}`)} · {date(latest.createdAt)}
            </span>
          </p>
          {latest.sha256 ? <p className="break-all font-mono text-xs">{latest.sha256}</p> : null}
          {latest.status === 'PENDING' ? <p className="text-muted-foreground">{t('detail.pending')}</p> : null}
          {latest.status === 'READY' && !acting ? (
            <OpenFileForm action={openFormAction}>
              <input type="hidden" name="formId" value={latest.id} />
              <Button type="submit" variant="outline" size="sm">
                {t('detail.download')}
              </Button>
            </OpenFileForm>
          ) : null}
          {items.map((r) => (
            <div key={r.id} className="rounded-md bg-muted/40 p-3">
              <RequestTimeline request={r} t={t} date={date} />
            </div>
          ))}
        </div>
      ) : state.forms !== null ? (
        <p className="text-sm text-muted-foreground">{t('deal.none')}</p>
      ) : null}

      {canGenerate ? (
        <form action={createCollaborationAgreementAction} className="flex flex-wrap items-end gap-2 text-sm">
          <input type="hidden" name="dealId" value={deal.id} />
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label className="flex flex-col gap-1">
            <span>{t('create.language')}</span>
            <select name="locale" defaultValue={locale} className={FIELD}>
              {UI_LOCALES.map((l) => (
                <option key={l} value={l}>
                  {t(`languages.${l}`)}
                </option>
              ))}
            </select>
          </label>
          <ActionButton
            label={t(latest ? 'deal.regenerate' : 'deal.generate')}
            confirm={latest ? t('deal.regenerateConfirm') : undefined}
          />
        </form>
      ) : null}

      {canSign && latest && signers ? (
        signers.own.length === 0 || signers.counterpart.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('deal.noSigners')}</p>
        ) : (
          <form action={sendDealSignatureAction} className="flex flex-col gap-3 border-t pt-3 text-sm">
            <h3 className="font-medium">{t('deal.send')}</h3>
            <p className="text-muted-foreground">{t('deal.sendIntro', { agency: counterpart })}</p>
            <input type="hidden" name="dealId" value={deal.id} />
            <input type="hidden" name="formId" value={latest.id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <div className="flex flex-col gap-2 sm:flex-row">
              <SignerSelect name="ownUserId" label={t('deal.ownSigner')} items={signers.own} t={t} />
              <SignerSelect
                name="counterpartUserId"
                label={t('deal.counterpartSigner', { agency: counterpart })}
                items={signers.counterpart}
                t={t}
              />
            </div>
            <RequestOptions t={t} />
            {items.some((r) => r.status === 'OPEN') ? (
              <p className="text-muted-foreground">{t('sign.supersedes')}</p>
            ) : null}
            <div>
              <ActionButton variant="default" label={t('sign.submit')} confirm={t('sign.confirm')} />
            </div>
          </form>
        )
      ) : null}
    </section>
  );
}

/**
 * The deal room's collaboration agreement (R2-05c, PLAN §7 M13): made from the deal as the database keeps it (both
 * agencies, the price, the terms snapshot and the commission split — R2-05a), then sent to both parties for signature
 * with the signers picked from each party's deal member and admins (`GET …/signers`; the API takes them by user id).
 * Hidden while `documents.forms` is off or forms are not the member's (403); the signing part while `documents.esign`
 * is off.
 */
export async function CollaborationAgreement({
  session,
  deal,
  locale,
  acting,
  query,
}: {
  session: SessionRef;
  deal: DealDto;
  locale: string;
  acting: boolean;
  query: Record<string, string | string[] | undefined>;
}) {
  const forms = await fetchForms(session, { dealId: deal.id, template: 'COLLABORATION_AGREEMENT', limit: 5 });
  if (forms === 'revoked') redirect('/session/expired');
  if (!forms.ok && (forms.error?.code === 'FORMS_NOT_ENABLED' || forms.status === 403)) return null;
  const latest = forms.ok ? forms.data.items[0] : undefined;
  const ready = latest?.status === 'READY' && deal.stage !== 'FELL_THROUGH' && !acting;
  const [signers, requests] = await Promise.all([
    ready ? fetchDealSigners(session, deal.id) : null,
    latest?.status === 'READY' ? fetchSignatureRequests(session, latest.id) : null,
  ]);
  if (signers === 'revoked' || requests === 'revoked') redirect('/session/expired');

  const tt = await getTranslations('documents.dashboard');
  const t: T = (key, values) => tt(key as never, values as never);
  const format = await getFormatter();
  return (
    <AgreementPanel
      deal={deal}
      state={{
        forms: forms.ok ? forms.data.items : null,
        requests: requests?.ok ? requests.data.items : null,
        signers: signers?.ok ? signers.data : null,
      }}
      locale={locale}
      acting={acting}
      query={query}
      t={t}
      date={(iso) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })}
    />
  );
}
