import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import type { EmailMessage } from '@inmolink/platform/email';

/** Auth emails rendered from `@inmolink/i18n` (EN/ES written by hand). Text + minimal escaped HTML. */
export type AuthEmailKind = 'VERIFY_EMAIL' | 'PASSWORD_RESET' | 'ACCOUNT_EXISTS';

const SECTION: Record<AuthEmailKind, string> = {
  VERIFY_EMAIL: 'email.verify',
  PASSWORD_RESET: 'email.reset',
  ACCOUNT_EXISTS: 'email.exists',
};

const TAG: Record<AuthEmailKind, string> = {
  VERIFY_EMAIL: 'identity.verify-email',
  PASSWORD_RESET: 'identity.password-reset',
  ACCOUNT_EXISTS: 'identity.account-exists',
};

/** The user's UI locale, or the default when it is no longer configured. Also the link's locale prefix. */
export const emailLocale = (locale: string) => (isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function message(
  to: string,
  tag: string,
  parts: { subject: string; greeting: string; body: string; action: string; ignore: string },
  link: string,
): EmailMessage {
  return {
    to,
    subject: parts.subject,
    tag,
    text: `${parts.greeting}\n\n${parts.body}\n\n${parts.action}: ${link}\n\n${parts.ignore}\n`,
    html: [
      `<p>${escapeHtml(parts.greeting)}</p>`,
      `<p>${escapeHtml(parts.body)}</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(parts.action)}</a></p>`,
      `<p style="color:#666">${escapeHtml(parts.ignore)}</p>`,
    ].join('\n'),
  };
}

/**
 * Invite to join an agency (S1-02). Agency and inviter names come from validated contract fields (no
 * links or markup) and are escaped in the HTML part.
 */
export function renderInviteEmail(
  invite: { email: string; locale: string },
  from: { agency: string; inviter: string },
  link: string,
): EmailMessage {
  const t = translator(emailLocale(invite.locale), 'auth');
  return message(
    invite.email,
    'identity.invite',
    {
      subject: t('email.invite.subject', from),
      greeting: t('email.invite.greeting'),
      body: t('email.invite.body', from),
      action: t('email.invite.action'),
      ignore: t('email.invite.ignore'),
    },
    link,
  );
}

export function renderAuthEmail(
  kind: AuthEmailKind,
  user: { email: string; name: string; locale: string },
  link: string,
): EmailMessage {
  const t = translator(emailLocale(user.locale), 'auth');
  const s = SECTION[kind];
  return message(
    user.email,
    TAG[kind],
    {
      subject: t(`${s}.subject`),
      greeting: t(`${s}.greeting`, { name: user.name }),
      body: t(`${s}.body`),
      action: t(`${s}.action`),
      ignore: t(`${s}.ignore`),
    },
    link,
  );
}

/**
 * Verification decision for an agency admin (S1-03). Agency name and staff reason come from validated
 * contract fields (no markup or controls) and are escaped in the HTML part.
 */
export function renderVerificationDecisionEmail(
  to: { email: string; name: string; locale: string },
  decision: { approved: boolean; agency: string; reason: string | null },
  link: string,
): EmailMessage {
  const t = translator(emailLocale(to.locale), 'verification');
  const s = decision.approved ? 'email.approved' : 'email.rejected';
  const params = { agency: decision.agency, name: to.name, reason: decision.reason ?? '' };
  return message(
    to.email,
    decision.approved ? 'agencies.verification-approved' : 'agencies.verification-rejected',
    {
      subject: t(`${s}.subject`, params),
      greeting: t(`${s}.greeting`, params),
      body: t(`${s}.body`, params),
      action: t(`${s}.action`),
      ignore: t(`${s}.footer`, params),
    },
    link,
  );
}
