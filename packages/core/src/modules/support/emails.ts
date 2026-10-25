import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import type { EmailMessage } from '@inmolink/platform/email';
import { escapeHtml, line } from '../../email-text';

/**
 * Support e-mails (S13-05), rendered from `@inmolink/i18n` (`support.email.*`, EN/ES written by hand). They name the
 * ticket and link to it; the conversation itself is read in the app (no message text in an e-mail).
 */

const localeOf = (locale: string) => (isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

export interface TicketMail {
  ticketId: string;
  subject: string;
  category: string;
  priority: string;
}

function render(to: string, tag: string, parts: { subject: string; body: string; action: string }, link: string) {
  const message: EmailMessage = {
    to,
    subject: line(parts.subject, 200),
    tag,
    text: `${parts.body}\n\n${parts.action}: ${link}\n`,
    html: [
      `<p>${escapeHtml(parts.body)}</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(parts.action)}</a></p>`,
    ].join('\n'),
  };
  return message;
}

/** Staff replied: to the member who opened the ticket, in their locale, linking to the ticket in the dashboard. */
export function renderStaffReplyEmail(
  to: { email: string; name: string; locale: string },
  ticket: TicketMail,
  webUrl: string,
): EmailMessage {
  const locale = localeOf(to.locale);
  const t = translator(locale, 'support');
  const params = { name: to.name, subject: ticket.subject };
  return render(
    to.email,
    'support.staff-reply',
    { subject: t('email.reply.subject', params), body: t('email.reply.body', params), action: t('email.reply.action') },
    `${webUrl}/${locale}/support/${ticket.ticketId}`,
  );
}

/** A new ticket or a member's reply: to the support inbox (the default locale), linking to the staff console. */
export function renderInboxEmail(to: string, ticket: TicketMail, isNew: boolean, webUrl: string): EmailMessage {
  const t = translator(DEFAULT_UI_LOCALE, 'support');
  const params = {
    subject: ticket.subject,
    category: t(`categories.${ticket.category}`),
    priority: t(`priorities.${ticket.priority}`),
  };
  const s = isNew ? 'email.inboxNew' : 'email.inboxReply';
  return render(
    to,
    isNew ? 'support.ticket-new' : 'support.ticket-reply',
    { subject: t(`${s}.subject`, params), body: t(`${s}.body`, params), action: t('email.inboxAction') },
    `${webUrl}/${DEFAULT_UI_LOCALE}/staff/support/${ticket.ticketId}`,
  );
}
