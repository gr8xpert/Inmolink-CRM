import { formatter } from '@inmolink/i18n';
import { createWebsiteClient, type WebsiteApiError, type WebsiteClient } from '../client';
import type { GetListingResponse, ListListingsQuery, ListListingsResponse } from '../website-v2.generated';
import { safeBaseUrl } from './connection';
import { el } from './dom';
import { leadForm } from './lead-form';
import { type MessageKey, pickLang, translate, type WidgetLang } from './messages';
import { WIDGET_CSS } from './styles';

/**
 * The JS widget (S8-06, PLAN §9.5): search form, result cards and a detail modal (with the S8-F8 lead form) on the
 * website API v2 with a publishable key (the page's origin must be on the key's allowlist). Plain DOM in a shadow root;
 * every API string goes in as `textContent` or a checked attribute, never as HTML. It shows what the API returns for the site's key — the
 * API is white-label already (no owner agency, commission or internal notes), the widget adds nothing to that.
 */
export interface WidgetOptions {
  /** A publishable key (`inl_…_pk…`). */
  apiKey: string;
  /** The website API origin, e.g. `https://feed.inmolink.es`. */
  baseUrl: string;
  /** `en` or `es` (default: the host element's `lang`, then the page's, then `en`). */
  lang?: string;
  /** Results per page (1–50, default 12). */
  pageSize?: number;
  /** Brand colour for buttons (`#rrggbb`). */
  primaryColor?: string;
  /**
   * The site's Cloudflare Turnstile site key (S8-F8). With it the detail modal shows the enquiry / viewing-request
   * form (publishable keys need the visitor's Turnstile token); without it, no form (the API would refuse it).
   */
  turnstileSiteKey?: string;
  /** The site's privacy notice (`https:`), linked from the form's consent box. */
  privacyUrl?: string;
  /** Test hook: a `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
}

export interface WidgetHandle {
  destroy(): void;
}

type Item = ListListingsResponse['items'][number];
type Size = 'thumb' | 'small' | 'medium' | 'large';
type Media = { urls: Partial<Record<Size, string>>; alt: string | null };

const HEX = /^#[0-9a-f]{6}$/i;
const SORTS = [
  ['newest', 'sortNewest'],
  ['price_asc', 'sortPriceAsc'],
  ['price_desc', 'sortPriceDesc'],
  ['beds_desc', 'sortBeds'],
  ['area_desc', 'sortArea'],
] as const;
const TRANSACTIONS = [
  ['SALE', 'sale'],
  ['RENT_LONG_TERM', 'rentLong'],
  ['RENT_SHORT_TERM', 'rentShort'],
] as const;

/** Only https image URLs reach an `<img src>`. */
const safeUrl = (u: string | undefined): string | undefined => (u && /^https:\/\//i.test(u) ? u : undefined);

const mediaUrl = (m: Media | null | undefined, order: Size[]): string | undefined =>
  m ? safeUrl(order.map((s) => m.urls[s]).find(Boolean)) : undefined;

/** The form takes whole euros; the API takes cents. */
const digits = (v: string): number | undefined => (/^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : undefined);

/** A constructable stylesheet where supported (works under a strict host CSP); a `<style>` element otherwise. */
let sheet: CSSStyleSheet | undefined;
function adoptStyles(root: ShadowRoot): void {
  try {
    sheet ??= new CSSStyleSheet();
    sheet.replaceSync(WIDGET_CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = el('style');
    style.textContent = WIDGET_CSS;
    root.append(style);
  }
}

export function mountWidget(host: HTMLElement, options: WidgetOptions): WidgetHandle {
  const lang: WidgetLang = pickLang(options.lang ?? (host.lang || document.documentElement.lang));
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars);
  const baseUrl = safeBaseUrl(options.baseUrl);
  if (!baseUrl) throw new TypeError('InmolinkWidget: baseUrl must be an https: URL');
  const client: WebsiteClient = createWebsiteClient({
    baseUrl,
    apiKey: options.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const pageSize = Math.min(50, Math.max(1, Math.trunc(Number(options.pageSize) || 12)));
  const fmt = formatter(lang);
  const money = (cents: number, currency: string) => {
    try {
      return fmt.money(cents, currency);
    } catch {
      return `${Math.round(cents / 100)} ${currency}`;
    }
  };
  const priceText = (p: Item['price']): string => {
    if (p.onRequest || p.amountCents === null) return t('onRequest');
    const price = money(p.amountCents, p.currency);
    if (!p.period) return price;
    return t(p.period === 'NIGHT' ? 'perNight' : p.period === 'WEEK' ? 'perWeek' : 'perMonth', { price });
  };

  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  root.replaceChildren();
  const container = el('div', { part: 'widget' });
  if (options.primaryColor && HEX.test(options.primaryColor)) {
    container.style.setProperty('--il-primary', options.primaryColor);
  }
  adoptStyles(root);
  root.append(container);

  // --- search form: structured only. The natural-language box comes with `/v2/search/ai` (S12-08): until the SDK has
  // that operation there is no AI box (a test checks), so no text is ever turned into prices or facts here.
  const text = (name: string, label: MessageKey, attrs: Record<string, string>) => {
    const field = el('input', { name, ...attrs });
    return { field, label: el('label', {}, t(label), field) };
  };
  const num = { inputmode: 'numeric', pattern: '[0-9]*' };
  const q = text('q', 'q', { type: 'search', maxlength: '80' });
  const priceMin = text('priceMin', 'priceMin', num);
  const priceMax = text('priceMax', 'priceMax', num);
  const bedsMin = text('bedsMin', 'bedsMin', num);
  const choice = (
    name: string,
    label: MessageKey,
    choices: readonly (readonly [string, MessageKey])[],
    any?: MessageKey,
  ) => {
    const field = el('select', { name });
    if (any) field.append(el('option', { value: '' }, t(any)));
    for (const [value, key] of choices) field.append(el('option', { value }, t(key)));
    return { field, label: el('label', {}, t(label), field) };
  };
  const transaction = choice('transaction', 'transaction', TRANSACTIONS, 'anyTransaction');
  const sort = choice('sort', 'sort', SORTS);
  const submit = el('button', { type: 'submit' }, t('submit'));
  const form = el(
    'form',
    { role: 'search', 'aria-label': t('label') },
    q.label,
    transaction.label,
    priceMin.label,
    priceMax.label,
    bedsMin.label,
    sort.label,
    submit,
  );
  const status = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const list = el('ul', { class: 'list' });
  const more = el('button', { type: 'button', class: 'more', hidden: '' }, t('more'));
  container.append(form, status, list, more);

  // --- results
  let cursor: string | null = null;
  let generation = 0;
  let destroyed = false;
  let uid = 0;

  const query = (): ListListingsQuery => {
    const keyword = q.field.value.trim();
    const tx = transaction.field.value as NonNullable<ListListingsQuery['transaction']> | '';
    const min = digits(priceMin.field.value);
    const max = digits(priceMax.field.value);
    const beds = digits(bedsMin.field.value);
    return {
      lang,
      limit: pageSize,
      sort: sort.field.value as NonNullable<ListListingsQuery['sort']>,
      ...(keyword ? { q: keyword } : {}),
      ...(tx ? { transaction: tx } : {}),
      ...(min !== undefined ? { priceMin: min * 100 } : {}),
      ...(max !== undefined ? { priceMax: max * 100 } : {}),
      ...(beds !== undefined ? { bedsMin: beds } : {}),
    };
  };

  function card(item: Item): HTMLElement {
    const cover = 'cover' in item ? item.cover : null;
    const url = mediaUrl(cover, ['medium', 'small', 'thumb', 'large']);
    const media = el('span', { class: 'media' });
    if (url) media.append(el('img', { src: url, alt: cover?.alt ?? item.title, loading: 'lazy', decoding: 'async' }));
    else media.append(t('noPhoto'));
    const built = 'builtM2' in item ? item.builtM2 : 'internalM2' in item ? item.internalM2 : null;
    const facts = [
      item.bedrooms !== null ? t('beds', { count: item.bedrooms }) : '',
      item.bathrooms !== null ? t('baths', { count: item.bathrooms }) : '',
      built ? t('built', { area: fmt.area(built) }) : '',
    ].filter(Boolean);
    const place = item.place.area?.name ?? item.place.city?.name ?? item.place.region?.name ?? '';
    // Spans, not paragraphs: a button may hold phrasing content only. The title names the button.
    const titleId = `il-t-${++uid}`;
    const button = el(
      'button',
      { type: 'button', 'aria-haspopup': 'dialog', 'aria-labelledby': titleId },
      media,
      el(
        'span',
        { class: 'body' },
        el('span', { class: 'price' }, priceText(item.price)),
        el('span', { class: 'title', id: titleId }, item.title),
        el('span', { class: 'muted' }, [item.propertyType.name, place].filter(Boolean).join(' · ')),
        el('span', { class: 'facts' }, facts.join(' · ')),
        el('span', { class: 'muted' }, t('ref', { ref: item.ref })),
      ),
    );
    button.addEventListener('click', () => void openDetail(item.ref, button));
    return el('li', { class: 'card' }, button);
  }

  async function load(append: boolean): Promise<void> {
    const mine = ++generation;
    submit.disabled = true;
    more.disabled = true;
    status.className = 'muted';
    status.textContent = t('loading');
    try {
      const res = await client.listListings({ ...query(), ...(append && cursor ? { cursor } : {}) });
      if (destroyed || mine !== generation) return;
      if (!append) list.replaceChildren();
      for (const item of res.items) list.append(card(item));
      cursor = res.nextCursor;
      more.hidden = cursor === null;
      status.textContent = list.children.length === 0 ? t('empty') : t('total', { count: res.total });
    } catch (e) {
      if (destroyed || mine !== generation) return;
      status.className = 'error';
      status.textContent = t('error');
      host.dispatchEvent(
        new CustomEvent('inmolink:error', {
          bubbles: true,
          composed: true,
          detail: { code: (e as Partial<WebsiteApiError>).code ?? 'NETWORK' },
        }),
      );
    } finally {
      if (!destroyed && mine === generation) {
        submit.disabled = false;
        more.disabled = false;
      }
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    cursor = null;
    more.hidden = true;
    void load(false);
  });
  more.addEventListener('click', () => void load(true));

  // --- detail modal
  let closeModal: (() => void) | undefined;
  const siteKey = options.turnstileSiteKey?.trim();

  async function openDetail(ref: string, opener: HTMLElement): Promise<void> {
    closeModal?.();
    const headingId = `il-h-${++uid}`;
    const heading = el('h2', { id: headingId }, t('loading'));
    const body = el('div');
    const closeButton = el('button', { type: 'button', class: 'close', 'aria-label': t('close') }, '×');
    const modal = el(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': headingId, tabindex: '-1' },
      closeButton,
      heading,
      body,
    );
    const overlay = el('div', { class: 'overlay' }, modal);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The dialog consumes it: a host page's own Escape handlers must not also fire.
        e.stopPropagation();
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      // Keep focus inside the dialog: the close button, the contact links and the lead form's visible controls.
      const focusable = [...modal.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea')].filter(
        (n) => !n.closest('[hidden]'),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && root.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && root.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    let lead: ReturnType<typeof leadForm> | undefined;
    function close() {
      lead?.destroy();
      overlay.remove();
      container.inert = false;
      document.removeEventListener('keydown', onKey, true);
      closeModal = undefined;
      opener.focus();
    }
    closeModal = close;
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', (e) => e.target === overlay && close());
    document.addEventListener('keydown', onKey, true);
    container.inert = true;
    root.append(overlay);
    closeButton.focus();
    try {
      const detail = await client.getListing({ ref }, { lang });
      if (closeModal !== close) return;
      heading.textContent = detail.title;
      body.replaceChildren(...detailNodes(detail));
      if (siteKey) {
        lead = leadForm({
          client,
          lang,
          t,
          ref: detail.ref,
          turnstileSiteKey: siteKey,
          privacyUrl: options.privacyUrl,
          host,
          id: ++uid,
          onSent: (sent) =>
            host.dispatchEvent(new CustomEvent('inmolink:lead', { bubbles: true, composed: true, detail: sent })),
        });
        body.append(lead.node);
      }
    } catch {
      if (closeModal !== close) return;
      heading.textContent = ref;
      body.replaceChildren(el('p', { class: 'error', role: 'alert' }, t('error')));
    }
  }

  function detailNodes(d: GetListingResponse): Node[] {
    const out: Node[] = [el('p', { class: 'price' }, priceText(d.price))];
    const images = ('media' in d ? d.media : []).filter((m): m is Extract<typeof m, { urls: unknown }> => 'urls' in m);
    const first = images[0];
    const heroUrl = mediaUrl(first, ['large', 'medium', 'small', 'thumb']);
    if (heroUrl) out.push(el('div', { class: 'hero' }, el('img', { src: heroUrl, alt: first?.alt ?? d.title })));
    const thumbs = images.slice(1, 13).flatMap((m) => {
      const u = mediaUrl(m, ['small', 'medium', 'thumb']);
      return u ? [el('img', { src: u, alt: m.alt ?? '', loading: 'lazy', decoding: 'async' })] : [];
    });
    if (thumbs.length > 0) out.push(el('div', { class: 'gallery' }, ...thumbs));
    const built = 'builtM2' in d ? d.builtM2 : 'internalM2' in d ? d.internalM2 : null;
    const plot = 'plotM2' in d ? d.plotM2 : null;
    const facts = [
      d.bedrooms !== null ? t('beds', { count: d.bedrooms }) : '',
      d.bathrooms !== null ? t('baths', { count: d.bathrooms }) : '',
      built ? t('built', { area: fmt.area(built) }) : '',
      plot ? t('plot', { area: fmt.area(plot) }) : '',
      'energyRating' in d && d.energyRating ? `${t('energy')}: ${d.energyRating}` : '',
      t('ref', { ref: d.ref }),
    ].filter(Boolean);
    out.push(el('p', { class: 'facts' }, facts.join(' · ')));
    if ('description' in d && d.description) out.push(el('h3', {}, t('description')), el('p', {}, d.description));
    if ('features' in d && d.features.length > 0) {
      out.push(
        el('h3', {}, t('features')),
        el('ul', { class: 'features' }, ...d.features.map((f) => el('li', {}, f.name))),
      );
    }
    // The presenting agency's own contact: the API never returns another agency's.
    const a = d.agency;
    const links: HTMLElement[] = [];
    if (a.phone) links.push(el('a', { href: `tel:${a.phone.replace(/[^\d+]/g, '')}` }, `${t('phone')}: ${a.phone}`));
    if (a.whatsapp) {
      links.push(
        el(
          'a',
          { href: `https://wa.me/${a.whatsapp.replace(/\D/g, '')}`, rel: 'noopener noreferrer', target: '_blank' },
          t('whatsapp'),
        ),
      );
    }
    if (a.email) links.push(el('a', { href: `mailto:${encodeURIComponent(a.email)}` }, `${t('email')}: ${a.email}`));
    out.push(el('h3', {}, `${t('contact')}: ${a.name}`), el('div', { class: 'contact' }, ...links));
    return out;
  }

  void load(false);
  return {
    destroy() {
      destroyed = true;
      closeModal?.();
      root.replaceChildren();
    },
  };
}
