import { LEAD_LIMITS, VIEWING_TIMES_OF_DAY, WEBSITE_LEAD_TURNSTILE_ACTION } from '@inmolink/contracts/values';
import type { WebsiteApiError, WebsiteClient } from '../client';
import type { CreateViewingRequestBody } from '../website-v2.generated';
import { el } from './dom';
import type { MessageKey, WidgetLang } from './messages';
import { loadTurnstile, type TurnstileApi } from './turnstile';

/**
 * The detail modal's enquiry / viewing-request form (S8-F8) on `POST /v2/leads` and `POST /v2/viewing-requests`
 * (S7-05): the lead belongs to the key's site's agency. A publishable key needs the visitor's Turnstile token, so the
 * form is shown only when the page gives a Turnstile site key. One Idempotency-Key per form shown: a retry after a lost
 * answer gets the first lead back instead of a second one. The visitor's text is only sent, never shown back as HTML.
 */
export interface LeadFormOptions {
  client: WebsiteClient;
  lang: WidgetLang;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** The listing's reference as the site shows it. */
  ref: string;
  turnstileSiteKey: string;
  /** The site's privacy notice (https), linked next to the consent box. */
  privacyUrl?: string | undefined;
  /**
   * The widget's host element: the Turnstile frame lives in its light DOM, shown in the form through a named slot
   * (Cloudflare's script renders into the page document, not into a shadow root).
   */
  host: HTMLElement;
  /** Unique per form in the page (slot name, heading id). */
  id: number;
  onSent: (detail: { id: string; kind: string }) => void;
}

type TimeOfDay = (typeof VIEWING_TIMES_OF_DAY)[number];
const TIMES: Record<TimeOfDay, MessageKey> = {
  MORNING: 'morning',
  AFTERNOON: 'afternoon',
  EVENING: 'evening',
  ANY: 'anyTime',
};

/** 16 random bytes as hex: the form's Idempotency-Key (`getRandomValues` works on http pages too). */
export function formKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `w-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The URL if it is a valid `https:` one (as the URL parser writes it), else nothing. */
function httpsHref(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Today in the visitor's time zone, `YYYY-MM-DD` (the API accepts a day of slack). */
function today(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function leadForm(o: LeadFormOptions): { node: HTMLElement; destroy(): void } {
  const { t } = o;
  let key = formKey();
  let token: string | undefined;
  let api: TurnstileApi | undefined;
  let widgetId: string | undefined;
  let destroyed = false;
  let sending = false;

  const field = (label: MessageKey, control: HTMLElement, cls = '') => el('label', { class: cls }, t(label), control);
  const check = (control: HTMLElement, ...text: (Node | string)[]) =>
    el('label', { class: 'check wide' }, control, el('span', {}, ...text));

  const kind = el(
    'select',
    { name: 'kind' },
    el('option', { value: 'ENQUIRY' }, t('kindEnquiry')),
    el('option', { value: 'VIEWING' }, t('kindViewing')),
  );
  const name = el('input', { name: 'name', autocomplete: 'name', required: '', maxlength: String(LEAD_LIMITS.name) });
  const email = el('input', {
    name: 'email',
    type: 'email',
    autocomplete: 'email',
    required: '',
    maxlength: String(LEAD_LIMITS.email),
  });
  const phone = el('input', { name: 'phone', type: 'tel', autocomplete: 'tel', maxlength: String(LEAD_LIMITS.phone) });
  const message = el('textarea', { name: 'message', rows: '4', maxlength: String(LEAD_LIMITS.message) });
  const date = el('input', { name: 'date', type: 'date', min: today() });
  const time = el('select', { name: 'timeOfDay' });
  for (const value of VIEWING_TIMES_OF_DAY) time.append(el('option', { value }, t(TIMES[value])));
  const viewing = [field('viewingDate', date), field('timeOfDay', time)];
  const privacy = el('input', { name: 'privacy', type: 'checkbox', required: '' });
  const privacyUrl = httpsHref(o.privacyUrl);
  const marketing = el('input', { name: 'marketing', type: 'checkbox' });
  const slot = `il-ts-${o.id}`;
  const challenge = el('div', { slot });
  const submit = el('button', { type: 'submit' }, t('send'));
  const status = el('p', { class: 'muted wide', role: 'status', 'aria-live': 'polite' });
  const headingId = `il-l-${o.id}`;

  const setViewing = () => {
    const on = kind.value === 'VIEWING';
    for (const label of viewing) label.hidden = !on;
    date.required = on;
  };
  setViewing();
  kind.addEventListener('change', setViewing);

  const form = el(
    'form',
    { class: 'lead', 'aria-labelledby': headingId },
    field('kind', kind, 'wide'),
    field('name', name),
    field('email', email),
    field('phoneOptional', phone),
    ...viewing,
    field('message', message, 'wide'),
    check(
      privacy,
      t('privacy'),
      ...(privacyUrl
        ? [' ', el('a', { href: privacyUrl, target: '_blank', rel: 'noopener noreferrer' }, t('privacyLink'))]
        : []),
    ),
    check(marketing, t('marketing')),
    el('div', { class: 'wide' }, el('slot', { name: slot })),
    submit,
    status,
  );
  const node = el('section', {}, el('h3', { id: headingId }, t('leadTitle')), form);

  const say = (cls: string, key: MessageKey) => {
    status.className = `${cls} wide`;
    status.textContent = t(key);
  };

  o.host.append(challenge);
  loadTurnstile()
    .then((a) => {
      if (destroyed) return;
      api = a;
      widgetId = a.render(challenge, {
        sitekey: o.turnstileSiteKey,
        action: WEBSITE_LEAD_TURNSTILE_ACTION,
        language: o.lang,
        callback: (value) => {
          token = value;
        },
        'error-callback': () => {
          token = undefined;
        },
        'expired-callback': () => {
          token = undefined;
        },
      });
    })
    .catch(() => {
      if (!destroyed) say('error', 'verifyUnavailable');
    });

  function setSending(on: boolean) {
    sending = on;
    form.setAttribute('aria-busy', String(on));
    submit.setAttribute('aria-disabled', String(on));
  }

  function cleanup() {
    if (api && widgetId) api.remove(widgetId);
    challenge.remove();
  }

  async function send(): Promise<void> {
    // Busy, not disabled: a disabled button would drop the keyboard focus out of the dialog.
    if (sending) return;
    if (!token) return say('error', 'verifyPending');
    setSending(true);
    say('muted', 'sending');
    // The page without its query or fragment (they may carry the visitor's search or tracking ids).
    const href = `${location.origin}${location.pathname}`;
    const text = (input: HTMLInputElement | HTMLTextAreaElement) => input.value.trim();
    const base = {
      name: text(name),
      email: text(email),
      ...(text(phone) ? { phone: text(phone) } : {}),
      lang: o.lang,
      // The API takes https page URLs only.
      ...(/^https:\/\//i.test(href) && href.length <= LEAD_LIMITS.pageUrl ? { pageUrl: href } : {}),
      privacyAccepted: true as const,
      marketingConsent: marketing.checked,
      turnstileToken: token,
      ref: o.ref,
      ...(text(message) ? { message: text(message) } : {}),
    };
    const headers = { 'idempotency-key': key };
    try {
      const res =
        kind.value === 'VIEWING'
          ? await o.client.createViewingRequest(
              {
                ...base,
                slots: [{ date: date.value, timeOfDay: time.value as TimeOfDay }],
              } satisfies CreateViewingRequestBody,
              headers,
            )
          : await o.client.createLead(base, headers);
      if (destroyed) return;
      cleanup();
      const sent = el('p', { class: 'sent', role: 'status', tabindex: '-1' }, t('sent'));
      form.replaceWith(sent);
      // The submit button is gone: keep the focus inside the dialog.
      sent.focus();
      o.onSent({ id: res.id, kind: res.kind });
    } catch (e) {
      if (destroyed) return;
      const code = (e as Partial<WebsiteApiError>).code;
      say(
        'error',
        code === 'TURNSTILE_FAILED'
          ? 'verifyFailed'
          : code === 'VALIDATION_FAILED'
            ? 'leadInvalid'
            : code === 'IDEMPOTENCY_KEY_REUSED'
              ? 'leadResend'
              : 'leadError',
      );
      // The key was taken by another body (the visitor edited the form after a lost answer): a new submission.
      if (code === 'IDEMPOTENCY_KEY_REUSED') key = formKey();
      // A token is checked once: the next try needs a fresh one.
      token = undefined;
      if (api && widgetId) api.reset(widgetId);
      setSending(false);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });

  return {
    node,
    destroy() {
      destroyed = true;
      cleanup();
    },
  };
}
