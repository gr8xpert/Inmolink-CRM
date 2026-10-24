import { DEFAULT_UI_LOCALE, formatter, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import type { EmailMessage } from '@inmolink/platform/email';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** One header-safe line. */
const line = (s: string, max: number) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').slice(0, max);

const EVENT_TYPES = ['VIEWING', 'MEETING', 'CALL'] as const;
type EventType = (typeof EVENT_TYPES)[number];
const typeOf = (type: string): EventType =>
  (EVENT_TYPES as readonly string[]).includes(type) ? (type as EventType) : 'MEETING';

/**
 * A calendar reminder (S10-06) in the member's UI language (EN / ES written by hand); the time in the agency's zone.
 * No attendees' details: the member opens the calendar for them.
 */
export function renderEventReminder(input: {
  to: string;
  name: string;
  locale: string;
  type: string;
  title: string;
  location: string | null;
  startsAt: Date;
  /** The agency's IANA time zone (S11-F11); the platform's when missing. */
  timeZone?: string;
}): EmailMessage {
  const locale = isUiLocale(input.locale) ? input.locale : DEFAULT_UI_LOCALE;
  const t = translator(locale, 'calendar');
  const when = formatter(locale, input.timeZone).dateTime(input.startsAt);
  const kind = t(`types.${typeOf(input.type)}`);
  const greeting = t('email.greeting', { name: line(input.name, 80) });
  const starts = t('email.starts', { when });
  const where = input.location ? t('email.where', { location: line(input.location, 300) }) : null;
  const text = [
    greeting,
    '',
    t('email.body', { kind }),
    '',
    input.title,
    starts,
    ...(where ? [where] : []),
    '',
    t('email.footer'),
    '',
  ].join('\n');
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(t('email.body', { kind }))}</p>`,
    `<p><strong>${escapeHtml(input.title)}</strong><br>${escapeHtml(starts)}${where ? `<br>${escapeHtml(where)}` : ''}</p>`,
    `<p style="color:#666">${escapeHtml(t('email.footer'))}</p>`,
  ].join('\n');
  return {
    to: input.to,
    subject: line(t('email.subject', { kind, title: line(input.title, 120) }), 250),
    text,
    html,
    tag: 'crm.event-reminder',
  };
}
