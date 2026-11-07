/**
 * Window-card templates (R2-06): complete HTML documents for the `pdf` renderer — one card per page, in the template's
 * paper size and orientation, with the agency's branding, the listing's key facts, its photos and a QR code (inline SVG)
 * to the listing's live page. Pure: they take what was read (white-labelled `WebsiteDetail`s, the presenting agency,
 * a QR per card) and a translator, and return a string. No script, no web fonts, no remote origin but the media CDN's.
 *
 * Sizes are `rem`s of a root size scaled by the paper (A3 = 1.414 × A4), so a layout is written once. The cards show
 * no description (the listing's page has it): titles, place, price and facts only, so a card never carries more than
 * the white-label sanitizer has passed.
 */
import {
  type WebsiteDetail,
  type WebsiteImage,
  type WebsitePresenter,
  WINDOW_CARD_TEMPLATES,
  type WindowCardTemplate,
} from '@inmolink/contracts';
import type { Translate } from '@inmolink/i18n/server';
import { escapeHtml } from '../../email-text';
import { placeText } from '../../place-text';
import { type DocFormat, docBadges, docColor, docContactLine, docImageSrc, docPriceText } from '../documents';

const e = (s: string | number | null | undefined) => escapeHtml(String(s ?? ''));

const DEFAULT_PRIMARY = '#1f3a5f';
const DEFAULT_ACCENT = '#c8a45d';
const TITLE_MAX = 90;

export const windowCardTemplate = (id: string): WindowCardTemplate => {
  const t = WINDOW_CARD_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new TypeError(`window card: unknown template ${id}`);
  return t;
};

/** Page size in mm (width, height) and the scale against A4. */
function page(t: WindowCardTemplate): { w: number; h: number; scale: number } {
  const [short, long] = t.size === 'A4' ? [210, 297] : [297, 420];
  const landscape = t.orientation === 'LANDSCAPE';
  return { w: landscape ? long : short, h: landscape ? short : long, scale: t.size === 'A4' ? 1 : 297 / 210 };
}

function css(t: WindowCardTemplate, presenter: WebsitePresenter): string {
  const { w, h, scale } = page(t);
  const primary = docColor(presenter.primaryColor, DEFAULT_PRIMARY);
  const accent = docColor(presenter.accentColor, DEFAULT_ACCENT);
  const landscape = t.orientation === 'LANDSCAPE';
  return `
@page { size: ${w}mm ${h}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { font-size: ${(4 * scale).toFixed(3)}mm; }
body { font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; color: #1d232b; line-height: 1.25; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.card { width: ${w}mm; height: ${h}mm; position: relative; overflow: hidden; page-break-after: always; break-after: page; display: flex; flex-direction: ${landscape && t.layout !== 'bold' ? 'row' : 'column'}; background: #fff; }
.card:last-child { page-break-after: auto; break-after: auto; }
.photo { background: #e8ebef center / cover no-repeat; min-height: 0; min-width: 0; }
.photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.agency { background: ${primary}; color: #fff; padding: .9rem 1.4rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.agency .name { font-size: 1.5rem; font-weight: 700; letter-spacing: .02em; }
.agency .contact { font-size: .95rem; text-align: right; opacity: .95; }
.body { padding: 1.2rem 1.6rem; display: flex; flex-direction: column; gap: .7rem; min-height: 0; }
.badge { display: inline-block; background: ${accent}; color: #1d232b; border-radius: .2rem; padding: .12rem .5rem; font-size: .9rem; font-weight: 700; margin-right: .4rem; }
h1 { font-size: 2rem; line-height: 1.15; margin: 0; color: ${primary}; }
.place { font-size: 1.15rem; color: #5b6573; }
.price { font-size: 2.6rem; font-weight: 800; color: ${primary}; line-height: 1.05; }
.facts { display: flex; gap: 1.2rem; flex-wrap: wrap; }
.fact .v { font-size: 1.6rem; font-weight: 700; }
.fact .k { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: #5b6573; }
.cta { margin-top: auto; display: flex; align-items: center; gap: 1.1rem; border-top: .15rem solid ${accent}; padding-top: .9rem; }
.qr { width: 7.5rem; height: 7.5rem; flex: none; background: #fff; }
.qr svg { width: 100%; height: 100%; display: block; }
.cta .scan { font-size: 1.05rem; font-weight: 600; color: ${primary}; }
.cta .ref { font-size: .9rem; color: #5b6573; margin-top: .25rem; }
.media { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.media .hero { flex: 1 1 0; }
.thumbs { display: flex; gap: .4rem; height: 8rem; }
.thumbs .photo { flex: 1; }
${layoutCss(t, primary)}
`;
}

function layoutCss(t: WindowCardTemplate, primary: string): string {
  const landscape = t.orientation === 'LANDSCAPE';
  switch (t.layout) {
    case 'classic':
      return `.media { flex: ${landscape ? '1.25' : '1.35'} 1 0; } .body { flex: 1 1 0; }`;
    case 'split':
      return `.media { flex: ${landscape ? '1.2' : '1'} 1 0; } .body { flex: 1 1 0; } .body .price { font-size: 3rem; }`;
    case 'gallery':
      return `.hero { flex: 1.5 1 0; } .body { flex: 1.3 1 0; } .qr { width: 6.5rem; height: 6.5rem; }`;
    case 'bold':
      return `.card { color: #fff; background: ${primary}; }
.hero { position: absolute; inset: 0; }
.shade { position: absolute; inset: 0; background: linear-gradient(to top, ${primary}f2 0%, ${primary}cc 38%, transparent 70%); }
.layer { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100%; }
.layer .agency { background: transparent; }
.layer .body { margin-top: auto; }
.layer h1, .layer .price, .layer .place, .layer .fact .v, .layer .cta .scan { color: #fff; }
.layer .fact .k, .layer .cta .ref { color: #e4e8ee; }
.layer .qr { padding: .35rem; border-radius: .3rem; }
.layer .price { font-size: 3.2rem; }`;
  }
}

function imageUrls(d: WebsiteDetail, count: number, size: 'large' | 'medium' | 'small'): string[] {
  if (d.kind !== 'LISTING') return [];
  const out: string[] = [];
  const cover = docImageSrc(d.cover, size);
  if (cover) out.push(cover);
  for (const m of d.media) {
    if (out.length >= count) break;
    if (m.kind === 'VIDEO' || m.cover) continue;
    const u = docImageSrc(m as WebsiteImage, size);
    if (u) out.push(u);
  }
  return out.slice(0, count);
}

const photo = (url: string | undefined, cls: string) =>
  url ? `<div class="photo ${cls}"><img src="${e(url)}" alt=""></div>` : `<div class="photo ${cls}"></div>`;

function facts(d: WebsiteDetail, t: Translate, f: DocFormat): string {
  const area = (m2: number | null) => (m2 === null ? null : `${f.number(m2)} m²`);
  const rows: [string, string | null][] = [
    [t('windowCard.bedrooms'), d.bedrooms === null ? null : String(d.bedrooms)],
    [t('windowCard.bathrooms'), d.bathrooms === null ? null : String(d.bathrooms)],
    [t('windowCard.area'), d.kind === 'LISTING' ? area(d.builtM2) : area(d.internalM2)],
    [t('windowCard.plot'), area(d.plotM2)],
  ];
  const shown = rows.filter((r): r is [string, string] => r[1] !== null);
  return shown.length === 0
    ? ''
    : `<div class="facts">${shown.map(([k, v]) => `<div class="fact"><div class="v">${e(v)}</div><div class="k">${e(k)}</div></div>`).join('')}</div>`;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export interface WindowCardInput {
  template: WindowCardTemplate;
  presenter: WebsitePresenter;
  /** One per card: the listing and the QR code (an inline `<svg>`) to its live page. */
  cards: readonly { detail: WebsiteDetail; qrSvg: string }[];
  t: Translate;
  format: DocFormat;
}

function agencyBand(p: WebsitePresenter): string {
  return `<div class="agency"><div class="name">${e(p.name)}</div><div class="contact">${docContactLine(p)}</div></div>`;
}

function text(d: WebsiteDetail, input: WindowCardInput, qrSvg: string): string {
  const { t, format: f } = input;
  const place = placeText(d.place);
  return `<div class="body"><div>${docBadges(d, t)}</div><h1>${e(cut(d.title, TITLE_MAX))}</h1>${
    place ? `<div class="place">${e(place)}</div>` : ''
  }<div class="price">${e(docPriceText(d, t, f))}</div>${facts(d, t, f)}<div class="cta"><div class="qr">${qrSvg}</div><div><div class="scan">${e(
    t('windowCard.scan'),
  )}</div><div class="ref">${e(t('listing.reference', { ref: d.ref }))}</div></div></div></div>`;
}

function card(d: WebsiteDetail, qrSvg: string, input: WindowCardInput): string {
  const { template, presenter } = input;
  switch (template.layout) {
    case 'classic':
    case 'split': {
      const [hero] = imageUrls(d, 1, input.template.size === 'A3' ? 'large' : 'medium');
      return `<section class="card"><div class="media">${agencyBand(presenter)}${photo(hero, 'hero')}</div>${text(d, input, qrSvg)}</section>`;
    }
    case 'gallery': {
      const urls = imageUrls(d, 4, 'medium');
      const thumbs = urls.slice(1, 4);
      return `<section class="card">${agencyBand(presenter)}${photo(urls[0], 'hero')}${
        thumbs.length > 0 ? `<div class="thumbs">${thumbs.map((u) => photo(u, '')).join('')}</div>` : ''
      }${text(d, input, qrSvg)}</section>`;
    }
    case 'bold': {
      const [hero] = imageUrls(d, 1, input.template.size === 'A3' ? 'large' : 'medium');
      return `<section class="card">${photo(hero, 'hero')}<div class="shade"></div><div class="layer">${agencyBand(presenter)}${text(d, input, qrSvg)}</div></section>`;
    }
  }
}

/** The whole batch: one page per card, in order. */
export function windowCardsHtml(input: WindowCardInput): string {
  if (input.cards.length === 0) throw new TypeError('window cards: no listing');
  const body = input.cards.map((c) => card(c.detail, c.qrSvg, input)).join('');
  return `<!doctype html><html lang="${e(input.format.locale)}"><head><meta charset="utf-8"><title>${e(
    input.presenter.name,
  )}</title><style>${css(input.template, input.presenter)}</style></head><body>${body}</body></html>`;
}
