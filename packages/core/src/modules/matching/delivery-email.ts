/**
 * Client alert e-mails (R2-02e): the client's "new properties for you" — the selection's page as the client sees it
 * (`presentations.selectionPage`: white-labelled, the agency's branding and contacts, live read models) with its link —
 * and, when the client is reached on WhatsApp, the agent's e-mail with the `wa.me` deep link that opens the chat with
 * the message ready. Texts from `@inmolink/i18n` (namespace `leads`, `profileAlert.*`; EN and ES). Everything a
 * listing, the agency or a member supplied is escaped in the HTML part; colours only when they are plain hex values.
 * A marketing e-mail: it says why the client gets it and how to stop it (reply / tell the agent) and carries the
 * contact's one-click unsubscribe link (R2-02g: in the body and as `List-Unsubscribe` / `List-Unsubscribe-Post`).
 */
import type { WebsiteDetail, WebsitePresenter } from '@inmolink/contracts';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import type { EmailMessage } from '@inmolink/platform/email';
import { escapeHtml, line } from '../../email-text';
import { placeText } from '../../place-text';
import { WHATSAPP_SHARE_URL } from '../chat';

/** Listing cards shown in the e-mail at most (the rest: "and N more in the selection"). */
export const ALERT_EMAIL_CARDS = 6;

const HEX = /^#[0-9a-fA-F]{6}$/;
const colour = (value: string | null, fallback: string) => (value && HEX.test(value) ? value : fallback);
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const uiLocale = (locale: string) => (isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

/** An https URL, or null (never another scheme in a link or an image). */
function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The client's first name for the greeting, or null (neutral): one word of letters, ≤ 40 characters. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return /^\p{L}[\p{L}'’-]{0,39}$/u.test(first) ? first : null;
}

/** A display name the e-mail adapter accepts (one line, no quotes or brackets, ≤ 100 chars). */
const senderName = (name: string) =>
  name
    .replace(/[\r\n"<>\\]+/g, ' ')
    .trim()
    .slice(0, 100) || 'Inmolink';

function priceText(d: WebsiteDetail, locale: string, onRequest: string): string {
  const { amountCents, currency } = d.price;
  if (d.price.onRequest || amountCents === null) return onRequest;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(
      amountCents / 100,
    );
  } catch {
    return `${Math.round(amountCents / 100)} ${currency}`;
  }
}

export interface AlertEmailInput {
  to: string;
  /** The client's first name (`firstNameOf`), or null. */
  firstName: string | null;
  /** The selection's language (the client's). */
  locale: string;
  /** The selection's page URL. */
  url: string;
  /** R2-02g: the contact's one-click unsubscribe link (`crm.unsubscribeUrl`). */
  unsubscribeUrl: string;
  presenter: WebsitePresenter;
  /** The page's items that can be shown, in order (white-labelled by the selection page). */
  items: readonly WebsiteDetail[];
  /** The provider's idempotency key (per delivery and attempt: a retry carries a new link). */
  idempotencyKey: string;
  /** Where replies go when the agency has no valid e-mail (the agent's): "reply to stop" must reach someone. */
  replyTo?: string;
}

/** The client's alert, branded as the agency (its name as sender, its address for replies). */
export function renderProfileAlert(input: AlertEmailInput): EmailMessage {
  const t = translator(uiLocale(input.locale), 'leads');
  const p = input.presenter;
  const count = input.items.length;
  const primary = colour(p.primaryColor, '#1f2937');
  const greeting = input.firstName
    ? t('profileAlert.greeting', { name: input.firstName })
    : t('profileAlert.greetingNeutral');
  const intro = t('profileAlert.intro', { count });
  const cards = input.items.slice(0, ALERT_EMAIL_CARDS).map((d) => ({
    title: line(d.title, 200),
    price: priceText(d, input.locale, t('profileAlert.priceOnRequest')),
    place: placeText(d.place, ['area', 'city']),
    beds: d.bedrooms === null ? null : t('profileAlert.bedrooms', { count: d.bedrooms }),
    image: d.kind === 'LISTING' ? httpsUrl(d.cover?.urls.small ?? d.cover?.urls.thumb ?? null) : null,
  }));
  const more = count > cards.length ? t('profileAlert.more', { count: count - cards.length }) : null;
  const contacts = [p.phone, p.email].filter((x): x is string => !!x);
  const website = httpsUrl(p.website);
  const url = httpsUrl(input.url) ?? input.url;
  const why = t('profileAlert.why', { agency: p.name });
  const stop = t('profileAlert.stop');
  const unsubscribe = httpsUrl(input.unsubscribeUrl) ?? input.unsubscribeUrl;

  const text = [
    greeting,
    '',
    intro,
    '',
    ...cards.map((c) => `- ${c.title} · ${c.price}${c.place ? ` · ${c.place}` : ''}${c.beds ? ` · ${c.beds}` : ''}`),
    ...(more ? [more] : []),
    '',
    `${t('profileAlert.cta')}: ${url}`,
    '',
    t('profileAlert.signature'),
    p.name,
    ...contacts,
    ...(website ? [website] : []),
    '',
    why,
    stop,
    t('profileAlert.unsubscribeText', { url: unsubscribe }),
    '',
  ].join('\n');

  const cardHtml = cards
    .map(
      (c) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">
  ${c.image ? `<img src="${escapeHtml(c.image)}" alt="" width="560" style="display:block;width:100%;max-width:560px;border-radius:4px">` : ''}
  <p style="margin:6px 0 2px;font-weight:bold">${escapeHtml(c.title)}</p>
  <p style="margin:0;color:${primary}">${escapeHtml(c.price)}</p>
  <p style="margin:0;color:#666;font-size:12px">${escapeHtml([c.place, c.beds].filter(Boolean).join(' · '))}</p>
</td></tr>`,
    )
    .join('\n');
  const html = [
    `<div style="font-family:Arial,sans-serif;max-width:600px">`,
    `<div style="background:${primary};color:#fff;padding:16px;font-size:18px;font-weight:bold">${escapeHtml(p.name)}</div>`,
    `<div style="padding:16px">`,
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<table role="presentation" style="width:100%;border-collapse:collapse">${cardHtml}</table>`,
    ...(more ? [`<p>${escapeHtml(more)}</p>`] : []),
    `<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:${primary};color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">${escapeHtml(t('profileAlert.cta'))}</a></p>`,
    `<p>${escapeHtml(t('profileAlert.signature'))}<br>${escapeHtml(p.name)}</p>`,
    ...(contacts.length ? [`<p style="color:#444;font-size:13px">${contacts.map(escapeHtml).join('<br>')}</p>`] : []),
    ...(website ? [`<p><a href="${escapeHtml(website)}" style="color:${primary}">${escapeHtml(website)}</a></p>`] : []),
    `<p style="color:#888;font-size:11px">${escapeHtml(why)}<br>${escapeHtml(stop)}<br><a href="${escapeHtml(unsubscribe)}" style="color:#666">${escapeHtml(t('profileAlert.unsubscribe'))}</a></p>`,
    `</div></div>`,
  ].join('\n');

  return {
    to: input.to,
    subject: line(t('profileAlert.subject', { count, agency: p.name }), 250),
    text,
    html,
    tag: 'matching.profile-alert',
    fromName: senderName(p.name),
    ...(p.email && EMAIL.test(p.email)
      ? { replyTo: p.email }
      : input.replyTo && EMAIL.test(input.replyTo)
        ? { replyTo: input.replyTo }
        : {}),
    idempotencyKey: input.idempotencyKey,
    // RFC 8058 one-click (https only; a local http origin keeps the body link)
    ...(httpsUrl(input.unsubscribeUrl) ? { listUnsubscribe: unsubscribe } : {}),
  };
}

/**
 * The `wa.me` deep link to the client with the alert's text in the client's language and the page's URL; the number
 * from the contact's phone (digits, ≥ 8), else a chat picker (no number).
 */
export function alertWhatsappUrl(input: {
  phone: string | null;
  firstName: string | null;
  locale: string;
  url: string;
}): string {
  const t = translator(uiLocale(input.locale), 'leads');
  const text = input.firstName
    ? t('profileAlert.whatsappText', { name: input.firstName, url: input.url })
    : t('profileAlert.whatsappTextNeutral', { url: input.url });
  const digits = (input.phone ?? '').replace(/\D/g, '');
  return `${WHATSAPP_SHARE_URL}${digits.length >= 8 ? digits : ''}?text=${encodeURIComponent(text)}`;
}

/** The agent's e-mail with the WhatsApp deep link (in the agent's language; the WhatsApp text is the client's). */
export function renderWhatsappHandoff(input: {
  to: string;
  /** The agent's UI language. */
  locale: string;
  /** The client's name as the agency knows it (the agent's own contact). */
  client: string;
  count: number;
  whatsappUrl: string;
  idempotencyKey: string;
}): EmailMessage {
  const t = translator(uiLocale(input.locale), 'leads');
  const client = line(input.client, 100);
  const subject = line(t('profileAlert.agentSubject', { client }), 250);
  const body = t('profileAlert.agentBody', { count: input.count, client });
  const footer = t('profileAlert.agentFooter', { client });
  const cta = t('profileAlert.agentCta');
  return {
    to: input.to,
    subject,
    text: [body, '', `${cta}: ${input.whatsappUrl}`, '', footer, ''].join('\n'),
    html: [
      `<div style="font-family:Arial,sans-serif;max-width:600px;padding:16px">`,
      `<p>${escapeHtml(body)}</p>`,
      `<p style="margin:20px 0"><a href="${escapeHtml(input.whatsappUrl)}" style="background:#25d366;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">${escapeHtml(cta)}</a></p>`,
      `<p style="color:#888;font-size:11px">${escapeHtml(footer)}</p>`,
      `</div>`,
    ].join('\n'),
    tag: 'matching.profile-alert-whatsapp',
    idempotencyKey: input.idempotencyKey,
  };
}
