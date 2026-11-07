import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import type { EmailMessage } from '@inmolink/platform/email';
import { escapeHtml, line } from '../../email-text';

/**
 * E-signature e-mails (R2-05b), from `@inmolink/i18n` (`documents.signing.email.*`, EN / ES by hand): the invitation
 * (the signing link), the one-time code, and "signed by everyone" (the signed PDF's link and SHA-256) to the signers
 * and to the member who asked. Sent by the agency's name from the platform's address. Bodies hold links and codes:
 * never log them.
 */

const localeOf = (locale: string) => (isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);
const fromNameOf = (agency: string) => line(agency.replace(/["<>()[\]\\,;:@]/g, ' '), 80) || undefined;

function render(input: {
  to: string;
  tag: string;
  subject: string;
  paragraphs: readonly string[];
  action?: { label: string; url: string };
  fromName?: string | undefined;
  idempotencyKey: string;
}): EmailMessage {
  const text = [...input.paragraphs, ...(input.action ? [`${input.action.label}: ${input.action.url}`] : [])].join(
    '\n\n',
  );
  const html = [
    ...input.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(input.action ? [`<p><a href="${escapeHtml(input.action.url)}">${escapeHtml(input.action.label)}</a></p>`] : []),
  ].join('\n');
  return {
    to: input.to,
    subject: line(input.subject, 200),
    text: `${text}\n`,
    html,
    tag: input.tag,
    idempotencyKey: input.idempotencyKey,
    ...(input.fromName ? { fromName: input.fromName } : {}),
  };
}

export function renderInviteEmail(input: {
  to: { email: string; name: string; locale: string };
  agencyName: string;
  document: string;
  expiresAt: Date;
  message: string | null;
  url: string;
  idempotencyKey: string;
}): EmailMessage {
  const locale = localeOf(input.to.locale);
  const t = translator(locale, 'documents');
  const expires = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(
    input.expiresAt,
  );
  const params = { agency: input.agencyName, document: input.document, name: input.to.name, expires };
  return render({
    to: input.to.email,
    tag: 'documents.signature-invite',
    subject: t('signing.email.inviteSubject', params),
    paragraphs: [
      t('signing.email.inviteBody', params),
      ...(input.message
        ? [t('signing.email.inviteMessage', { agency: input.agencyName, message: input.message })]
        : []),
    ],
    action: { label: t('signing.email.inviteAction'), url: input.url },
    fromName: fromNameOf(input.agencyName),
    idempotencyKey: input.idempotencyKey,
  });
}

export function renderCodeEmail(input: {
  to: { email: string; locale: string };
  agencyName: string;
  document: string;
  code: string;
  idempotencyKey: string;
}): EmailMessage {
  const t = translator(localeOf(input.to.locale), 'documents');
  const params = { code: input.code, document: input.document };
  return render({
    to: input.to.email,
    tag: 'documents.signature-code',
    subject: t('signing.email.codeSubject', params),
    paragraphs: [t('signing.email.codeBody', params)],
    fromName: fromNameOf(input.agencyName),
    idempotencyKey: input.idempotencyKey,
  });
}

export function renderCompletedEmail(input: {
  to: { email: string; locale: string };
  agencyName: string;
  document: string;
  sha256: string;
  /** The signer's link to the signed PDF; null for the requester (it is in the dashboard). */
  url: string | null;
  idempotencyKey: string;
}): EmailMessage {
  const t = translator(localeOf(input.to.locale), 'documents');
  const params = { document: input.document, hash: input.sha256 };
  const signer = input.url !== null;
  return render({
    to: input.to.email,
    tag: signer ? 'documents.signature-completed' : 'documents.signature-completed-requester',
    subject: t(signer ? 'signing.email.completedSubject' : 'signing.email.requesterSubject', params),
    paragraphs: [t(signer ? 'signing.email.completedBody' : 'signing.email.requesterBody', params)],
    ...(input.url ? { action: { label: t('signing.email.completedAction'), url: input.url } } : {}),
    fromName: fromNameOf(input.agencyName),
    idempotencyKey: input.idempotencyKey,
  });
}
