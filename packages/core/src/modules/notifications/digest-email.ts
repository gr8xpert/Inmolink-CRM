import { DEFAULT_UI_LOCALE, formatter, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import type { EmailMessage } from '@inmolink/platform/email';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** One header-safe line. */
const line = (s: string, max: number) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').slice(0, max);

/** Notifications listed in one digest; the rest are counted ("…and 3 more"). */
export const DIGEST_LISTED = 20;

export interface DigestItem {
  type: string;
  params: Record<string, string | number>;
  createdAt: Date;
}

/** The type's message with its params; a param the emitter left out reads as empty, never as a raw `{key}`. */
function message(t: ReturnType<typeof translator>, item: DigestItem): string {
  const values: Record<string, string | number> = { subject: '', actor: '' };
  for (const [k, v] of Object.entries(item.params)) values[k] = typeof v === 'string' ? line(v, 200) : v;
  return line(t(`types.${item.type}`, values), 300);
}

/**
 * The e-mail digest (S11-04) in the member's UI language (EN / ES written by hand): the oldest `DIGEST_LISTED`
 * notifications with their time (platform time zone), and how many more. Text only from the catalog and the
 * notifications' own display params — no links (the dashboard's URL is the web app's to give).
 */
export function renderDigest(input: { to: string; name: string; locale: string; items: DigestItem[] }): EmailMessage {
  const locale = isUiLocale(input.locale) ? input.locale : DEFAULT_UI_LOCALE;
  const t = translator(locale, 'notifications');
  const fmt = formatter(locale);
  const listed = input.items.slice(0, DIGEST_LISTED);
  const more = input.items.length - listed.length;
  const rows = listed.map((item) => ({ when: fmt.dateTime(item.createdAt), text: message(t, item) }));
  const greeting = t('email.greeting', { name: line(input.name, 80) });
  const text = [
    greeting,
    '',
    t('email.body'),
    '',
    ...rows.map((r) => `- ${r.text} (${r.when})`),
    ...(more > 0 ? [t('email.more', { count: more })] : []),
    '',
    t('email.action'),
    '',
    t('email.footer'),
  ].join('\n');
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(t('email.body'))}</p>`,
    `<ul>${rows.map((r) => `<li>${escapeHtml(r.text)} <span style="color:#666">${escapeHtml(r.when)}</span></li>`).join('')}</ul>`,
    ...(more > 0 ? [`<p>${escapeHtml(t('email.more', { count: more }))}</p>`] : []),
    `<p>${escapeHtml(t('email.action'))}</p>`,
    `<p style="color:#666">${escapeHtml(t('email.footer'))}</p>`,
  ].join('\n');
  return {
    to: input.to,
    subject: line(t('email.subject', { count: input.items.length }), 250),
    text,
    html,
    tag: 'notifications.digest',
  };
}
