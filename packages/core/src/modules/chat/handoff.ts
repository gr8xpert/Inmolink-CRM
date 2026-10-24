import type { ChatHandoffDto } from '@inmolink/contracts';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';

/** WhatsApp's share link (wa.me "click to chat" without a number: the member picks the recipient in WhatsApp). */
export const WHATSAPP_SHARE_URL = 'https://wa.me/';

/**
 * One line of display text: control characters, line / paragraph separators and format characters (bidi overrides)
 * out — joiners kept — at most `max` characters.
 */
const line = (s: string, max: number) =>
  s.replace(/(?:[\p{Cc}\p{Zl}\p{Zp}]|[^\P{Cf}\p{Join_Control}])+/gu, ' ').slice(0, max);

/**
 * WhatsApp / e-mail handoff (S11-03, PLAN §7 M12): deep links that open the member's own WhatsApp or mail client with a
 * short text naming the thread's subject — no recipient (the member picks one there), no provider, no keys, nothing of
 * the conversation or of a client. A provider-sent handoff (WhatsApp Business, our SMTP) would need keys: not built.
 */
export function handoffLinks(input: { locale: string; kind: string; subject: string | null; title: string | null }) {
  const locale = isUiLocale(input.locale) ? input.locale : DEFAULT_UI_LOCALE;
  const t = translator(locale, 'chat');
  const name = line(input.subject ?? input.title ?? '', 120);
  const subject =
    input.kind === 'VIEWING' && input.subject
      ? t('handoff.subjectViewing', { subject: name })
      : name || t('handoff.subjectDirect');
  const text = t('handoff.text', { subject });
  const links: ChatHandoffDto = {
    whatsappUrl: `${WHATSAPP_SHARE_URL}?text=${encodeURIComponent(text)}`,
    emailUrl: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`,
  };
  return links;
}
