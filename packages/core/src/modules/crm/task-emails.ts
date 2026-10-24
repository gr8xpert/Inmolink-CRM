import { DEFAULT_UI_LOCALE, formatter, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import type { EmailMessage } from '@inmolink/platform/email';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** One header-safe line. */
const line = (s: string, max: number) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').slice(0, max);

/** A task reminder in the assignee's UI language (EN / ES written by hand); the time in the agency's zone. */
export function renderTaskReminder(input: {
  to: string;
  name: string;
  locale: string;
  title: string;
  description: string | null;
  dueAt: Date;
  /** The agency's IANA time zone (S11-F11); the platform's when missing. */
  timeZone?: string;
}): EmailMessage {
  const locale = isUiLocale(input.locale) ? input.locale : DEFAULT_UI_LOCALE;
  const t = translator(locale, 'tasks');
  const when = formatter(locale, input.timeZone).dateTime(input.dueAt);
  const greeting = t('email.greeting', { name: line(input.name, 80) });
  const due = t('email.due', { when });
  const text = [
    greeting,
    '',
    t('email.body'),
    '',
    input.title,
    ...(input.description ? [input.description] : []),
    due,
    '',
    t('email.action'),
    '',
    t('email.footer'),
    '',
  ].join('\n');
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(t('email.body'))}</p>`,
    `<p><strong>${escapeHtml(input.title)}</strong>${
      input.description ? `<br>${escapeHtml(input.description).replace(/\n/g, '<br>')}` : ''
    }<br>${escapeHtml(due)}</p>`,
    `<p>${escapeHtml(t('email.action'))}</p>`,
    `<p style="color:#666">${escapeHtml(t('email.footer'))}</p>`,
  ].join('\n');
  return {
    to: input.to,
    subject: line(t('email.subject', { title: line(input.title, 120) }), 250),
    text,
    html,
    tag: 'crm.task-reminder',
  };
}
