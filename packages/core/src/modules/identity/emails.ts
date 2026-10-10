import { DEFAULT_UI_LOCALE, isUiLocale, translator } from '@inmolink/i18n';
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

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function renderAuthEmail(
  kind: AuthEmailKind,
  user: { email: string; name: string; locale: string },
  link: string,
): EmailMessage {
  const t = translator(isUiLocale(user.locale) ? user.locale : DEFAULT_UI_LOCALE, 'auth');
  const s = SECTION[kind];
  const greeting = t(`${s}.greeting`, { name: user.name });
  const body = t(`${s}.body`);
  const action = t(`${s}.action`);
  const ignore = t(`${s}.ignore`);
  return {
    to: user.email,
    subject: t(`${s}.subject`),
    tag: TAG[kind],
    text: `${greeting}\n\n${body}\n\n${action}: ${link}\n\n${ignore}\n`,
    html: [
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>${escapeHtml(body)}</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p>`,
      `<p style="color:#666">${escapeHtml(ignore)}</p>`,
    ].join('\n'),
  };
}
