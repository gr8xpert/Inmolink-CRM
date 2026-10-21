/**
 * Website lead e-mails (S7-05): the visitor's acknowledgement (speed-to-lead, PLAN §3 #60) in the visitor's language
 * with the site's branding and three similar listings from the site's inventory, and the presenting agency's
 * notification. Texts from `@inmolink/i18n` (namespace `leads`; EN and ES written by hand, other languages fall back to
 * EN until drafted). Everything the visitor or a listing supplies is escaped in the HTML part; colours are used only
 * when they are plain hex values.
 */
import type { ViewingSlot, WebsiteCard, WebsitePresenter } from '@inmolink/contracts';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import type { EmailMessage } from '@inmolink/platform/email';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const HEX = /^#[0-9a-fA-F]{6}$/;
const colour = (value: string | null, fallback: string) => (value && HEX.test(value) ? value : fallback);

/** An https URL, or null (never a `javascript:` or other scheme in a link). */
function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** One line of a header-safe subject: no line breaks, bounded. */
const subjectLine = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 250);

function priceText(card: WebsiteCard, locale: string, onRequest: string): string {
  const { amountCents, currency } = card.price;
  if (card.price.onRequest || amountCents === null) return onRequest;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(
      amountCents / 100,
    );
  } catch {
    return `${Math.round(amountCents / 100)} ${currency}`;
  }
}

function placeText(card: WebsiteCard): string {
  const p = card.place;
  return [p.area?.name, p.city?.name].filter(Boolean).join(', ');
}

function imageOf(card: WebsiteCard): string | null {
  const cover = card.kind === 'LISTING' ? card.cover : null;
  return httpsUrl(cover?.urls.small ?? cover?.urls.thumb ?? null);
}

/**
 * The visitor's first name for the greeting, or null (a neutral greeting): the first word only, letters, hyphens and
 * apostrophes, at most 40 characters — the acknowledgement never echoes free text a form sender typed (phishing).
 */
export function greetingName(name: string): string | null {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return /^\p{L}[\p{L}'’-]{0,39}$/u.test(first) ? first : null;
}

/** A display name the e-mail adapter accepts (one line, no quotes or brackets, ≤ 100 chars). */
const senderName = (name: string) =>
  name
    .replace(/[\r\n"<>\\]+/g, ' ')
    .trim()
    .slice(0, 100) || 'Website';

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

export interface LeadAckInput {
  to: string;
  name: string;
  /** The visitor's language (one of the site's). */
  locale: string;
  kind: 'ENQUIRY' | 'VIEWING_REQUEST';
  /** The reference the site shows (null: a general enquiry). */
  ref: string | null;
  presenter: WebsitePresenter;
  /** Up to three of the site's listings, white-labelled by the website serializer. */
  similar: readonly WebsiteCard[];
}

/** The visitor's acknowledgement, branded as the site (presenting agency's name, colours and contacts). */
export function renderLeadAck(input: LeadAckInput): EmailMessage {
  const t = translator(input.locale, 'leads');
  const p = input.presenter;
  const first = greetingName(input.name);
  const greeting = first ? t('ack.greeting', { name: first }) : t('ack.greetingNeutral');
  const primary = colour(p.primaryColor, '#1f2937');
  const site = p.website ? (httpsUrl(p.website) ?? p.name) : p.name;
  const subject = subjectLine(
    t(input.kind === 'VIEWING_REQUEST' ? 'ack.subjectViewing' : 'ack.subject', { agency: p.name }),
  );
  const body =
    input.kind === 'VIEWING_REQUEST'
      ? t('ack.bodyViewing', { ref: input.ref ?? '' })
      : input.ref
        ? t('ack.bodyListing', { ref: input.ref })
        : t('ack.bodyGeneral');
  const contacts = [
    p.phone ? t('ack.phone', { phone: p.phone }) : null,
    p.email ? t('ack.email', { email: p.email }) : null,
    p.whatsapp ? t('ack.whatsapp', { whatsapp: p.whatsapp }) : null,
  ].filter((x): x is string => x !== null);
  const cards = input.similar.slice(0, 3).map((card) => ({
    title: card.title,
    ref: t('ack.reference', { ref: card.ref }),
    price: priceText(card, input.locale, t('ack.priceOnRequest')),
    place: placeText(card),
    beds: card.bedrooms === null ? null : t('ack.bedrooms', { count: card.bedrooms }),
    image: imageOf(card),
  }));
  const website = httpsUrl(p.website);

  const text = [
    greeting,
    '',
    body,
    ...(cards.length
      ? [
          '',
          t('ack.similarTitle'),
          ...cards.map((c) => `- ${c.title} (${c.ref}) · ${c.price}${c.place ? ` · ${c.place}` : ''}`),
        ]
      : []),
    '',
    t('ack.signature'),
    p.name,
    ...(contacts.length ? ['', t('ack.contactTitle'), ...contacts] : []),
    ...(website ? [website] : []),
    '',
    t('ack.footer', { site }),
    '',
  ].join('\n');

  const cardHtml = cards
    .map(
      (c) => `<td style="width:33%;vertical-align:top;padding:6px">
  ${c.image ? `<img src="${escapeHtml(c.image)}" alt="" width="180" style="display:block;width:100%;max-width:180px;border-radius:4px">` : ''}
  <p style="margin:6px 0 2px;font-weight:bold">${escapeHtml(c.title)}</p>
  <p style="margin:0;color:${primary}">${escapeHtml(c.price)}</p>
  <p style="margin:0;color:#666;font-size:12px">${escapeHtml([c.place, c.beds].filter(Boolean).join(' · '))}</p>
  <p style="margin:0;color:#999;font-size:11px">${escapeHtml(c.ref)}</p>
</td>`,
    )
    .join('\n');
  const html = [
    `<div style="font-family:Arial,sans-serif;max-width:600px">`,
    `<div style="background:${primary};color:#fff;padding:16px;font-size:18px;font-weight:bold">${escapeHtml(p.name)}</div>`,
    `<div style="padding:16px">`,
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(body)}</p>`,
    ...(cards.length
      ? [
          `<h3 style="color:${primary}">${escapeHtml(t('ack.similarTitle'))}</h3>`,
          `<table role="presentation" style="width:100%;border-collapse:collapse"><tr>${cardHtml}</tr></table>`,
        ]
      : []),
    `<p>${escapeHtml(t('ack.signature'))}<br>${escapeHtml(p.name)}</p>`,
    ...(contacts.length
      ? [
          `<p style="color:#444;font-size:13px"><strong>${escapeHtml(t('ack.contactTitle'))}</strong><br>${contacts
            .map(escapeHtml)
            .join('<br>')}</p>`,
        ]
      : []),
    ...(website ? [`<p><a href="${escapeHtml(website)}" style="color:${primary}">${escapeHtml(website)}</a></p>`] : []),
    `<p style="color:#888;font-size:11px">${escapeHtml(t('ack.footer', { site }))}</p>`,
    `</div></div>`,
  ].join('\n');

  // The site's branding on the envelope too: its name as the sender (the platform's address) and its contact for replies.
  return {
    to: input.to,
    subject,
    text,
    html,
    tag: 'website.lead-ack',
    fromName: senderName(p.name),
    ...(p.email && EMAIL.test(p.email) ? { replyTo: p.email } : {}),
  };
}

export interface LeadNotifyInput {
  to: string;
  /** The recipient's UI language. */
  locale: string;
  kind: 'ENQUIRY' | 'VIEWING_REQUEST';
  ref: string | null;
  /** The site as the agency knows it (its name in the dashboard). */
  siteName: string;
  lead: {
    name: string;
    email: string;
    phone: string | null;
    message: string | null;
    locale: string;
    marketingConsent: boolean;
    pageUrl: string | null;
    slots: readonly ViewingSlot[];
  };
}

/** The UI locale an agency recipient reads (EN when theirs has no catalog). */
export const notifyLocale = (locale: string) => (isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

/** The presenting agency's notification of a new website lead: the visitor's details, for the agency only. */
export function renderLeadNotification(input: LeadNotifyInput): EmailMessage {
  const t = translator(notifyLocale(input.locale), 'leads');
  const viewing = input.kind === 'VIEWING_REQUEST';
  const subject = subjectLine(
    viewing
      ? t('notify.subjectViewing', { ref: input.ref ?? '' })
      : input.ref
        ? t('notify.subject', { ref: input.ref })
        : t('notify.subjectGeneral'),
  );
  const l = input.lead;
  const rows: [string, string][] = [
    [t('notify.name'), l.name],
    [t('notify.email'), l.email],
    ...(l.phone ? [[t('notify.phone'), l.phone] as [string, string]] : []),
    ...(input.ref ? [[t('notify.listing'), input.ref] as [string, string]] : []),
    ...(l.slots.length
      ? [
          [t('notify.slots'), l.slots.map((s) => `${s.date} (${t(`notify.timeOfDay.${s.timeOfDay}`)})`).join(', ')] as [
            string,
            string,
          ],
        ]
      : []),
    [t('notify.language'), l.locale],
    [t('notify.marketing'), l.marketingConsent ? t('notify.yes') : t('notify.no')],
    ...(l.pageUrl ? [[t('notify.page'), l.pageUrl] as [string, string]] : []),
  ];
  const intro = t(viewing ? 'notify.introViewing' : 'notify.intro', { site: input.siteName });
  const text = [
    intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(l.message ? ['', `${t('notify.message')}:`, l.message] : []),
    '',
    t('notify.footer'),
    '',
  ].join('\n');
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    `<table role="presentation">${rows
      .map(
        ([k, v]) => `<tr><td style="padding-right:12px;color:#666">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`,
      )
      .join('')}</table>`,
    ...(l.message
      ? [
          `<p><strong>${escapeHtml(t('notify.message'))}</strong></p><p style="white-space:pre-wrap">${escapeHtml(l.message)}</p>`,
        ]
      : []),
    `<p style="color:#888;font-size:12px">${escapeHtml(t('notify.footer'))}</p>`,
  ].join('\n');
  return { to: input.to, subject, text, html, tag: 'website.lead-notify' };
}
