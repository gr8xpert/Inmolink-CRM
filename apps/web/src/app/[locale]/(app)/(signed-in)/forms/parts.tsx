import {
  type FormDocumentDto,
  SIGNATURE_EXPIRY_DAYS_DEFAULT,
  SIGNATURE_EXPIRY_DAYS_MAX,
  type SignatureRequestDto,
} from '@inmolink/contracts';
import { UI_LOCALES } from '@inmolink/i18n';
import { EmptyState } from '@inmolink/ui';
import { Link } from '@/i18n/navigation';

/**
 * Pieces the forms screens share (R2-05c): the placeholder warning, a list of forms, a signing request's timeline and
 * the signer rows of a send-for-signature form. Server components; strings come in through `t`
 * (`documents.dashboard`).
 */

export type T = (key: string, values?: Record<string, string | number>) => string;

const FIELD = 'h-9 rounded-md border bg-background px-2';

/** The clause texts are placeholders pending lawyer review (H17): said on every forms screen, not only in the PDF. */
export function PlaceholderNotice({ t }: { t: T }) {
  return (
    <p
      role="note"
      className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm font-medium text-destructive"
    >
      {t('placeholder')}
    </p>
  );
}

export function FormList({
  items,
  t,
  date,
}: {
  items: readonly FormDocumentDto[];
  t: T;
  date: (iso: string) => string;
}) {
  if (items.length === 0) return <EmptyState title={t('empty')} />;
  return (
    <ul className="flex flex-col divide-y text-sm" data-testid="form-list">
      {items.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="min-w-0">
            <Link href={`/forms/${f.id}`} className="font-medium underline-offset-4 hover:underline">
              {t(`templates.${f.template}`)}
            </Link>{' '}
            <span className="break-words text-muted-foreground">· {f.label}</span>
          </span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t(`statuses.${f.status}`)}</span>
            {f.placeholder ? <span className="text-destructive">{t('placeholderShort')}</span> : null}
            <span>{date(f.createdAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One signing request: its state, then each signer — invited, signed (how, from where) or waiting. */
export function RequestTimeline({
  request,
  t,
  date,
}: {
  request: SignatureRequestDto;
  t: T;
  date: (iso: string) => string;
}) {
  const r = request;
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="signature-request">
      <p>
        <span className="font-medium">{t(`requests.statuses.${r.status}`)}</span>
        {' · '}
        {t('requests.created', { date: date(r.createdAt) })}
        {' · '}
        {r.completedAt
          ? t('requests.completed', { date: date(r.completedAt) })
          : r.cancelledAt
            ? t('requests.cancelled', { date: date(r.cancelledAt) })
            : t('requests.expires', { date: date(r.expiresAt) })}
        {r.ordered ? ` · ${t('requests.ordered')}` : ''}
      </p>
      <ol className="flex flex-col gap-1 border-l pl-3">
        {r.signers.map((s) => (
          <li key={s.id} className="flex flex-col">
            <span>
              <span className="font-medium">{s.name}</span> · {s.email} · {t(`roles.${s.role}`)}
            </span>
            <span className="text-xs text-muted-foreground">
              {s.signedAt
                ? t('requests.signedAt', {
                    date: date(s.signedAt),
                    how: t(s.signatureKind === 'DRAWN' ? 'requests.drawn' : 'requests.typed'),
                    ip: s.signedIp ?? '—',
                  })
                : s.invitedAt
                  ? t('requests.invited', { date: date(s.invitedAt) })
                  : t('requests.notInvited')}
            </span>
          </li>
        ))}
      </ol>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 text-xs">
        <dt className="text-muted-foreground">{t('requests.documentHash')}</dt>
        <dd className="break-all font-mono">{r.documentSha256}</dd>
        {r.signedSha256 ? (
          <>
            <dt className="text-muted-foreground">{t('requests.signedHash')}</dt>
            <dd className="break-all font-mono">{r.signedSha256}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

export interface SignerPrefill {
  name: string;
  email: string;
  role: string;
}

/** Rows of signers (`signer.<n>.*`): the template's roles, prefilled where the screen knows who signs; empty rows skip. */
export function SignerRows({
  roles,
  prefill,
  rows,
  t,
}: {
  roles: readonly string[];
  prefill: readonly SignerPrefill[];
  rows: number;
  t: T;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{t('sign.signers')}</legend>
      <p className="text-xs text-muted-foreground">{t('sign.rowsHint')}</p>
      {Array.from({ length: rows }, (_, i) => `signer-${i}`).map((slot, i) => {
        const p = prefill[i];
        return (
          <div key={slot} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1">
              <span>{t('sign.name', { n: i + 1 })}</span>
              <input name={`signer.${i}.name`} defaultValue={p?.name} maxLength={200} className={FIELD} />
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span>{t('sign.email')}</span>
              <input
                name={`signer.${i}.email`}
                type="email"
                defaultValue={p?.email}
                maxLength={254}
                autoComplete="off"
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>{t('sign.role')}</span>
              <select name={`signer.${i}.role`} defaultValue={p?.role ?? roles[0]} className={FIELD}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {t(`roles.${r}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span>{t('sign.language')}</span>
              <select name={`signer.${i}.locale`} defaultValue="" className={FIELD}>
                <option value="">{t('sign.languageDefault')}</option>
                {UI_LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {t(`languages.${l}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/** Order, expiry and message of a signing request. */
export function RequestOptions({ t }: { t: T }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <input type="checkbox" name="ordered" />
        <span>{t('sign.ordered')}</span>
      </label>
      <label className="flex flex-col gap-1 sm:w-48">
        <span>{t('sign.expiresInDays')}</span>
        <input
          name="expiresInDays"
          type="number"
          min={1}
          max={SIGNATURE_EXPIRY_DAYS_MAX}
          defaultValue={SIGNATURE_EXPIRY_DAYS_DEFAULT}
          required
          className={FIELD}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span>{t('sign.message')}</span>
        <textarea name="message" maxLength={1000} rows={2} className="rounded-md border bg-background p-2" />
      </label>
    </div>
  );
}
