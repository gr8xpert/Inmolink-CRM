/**
 * PDF templates (S12-05): complete HTML documents for the `pdf` renderer — a brochure (one listing), a portfolio (a
 * cover and one page per listing) and the accepted viewing terms (S11-02). Pure: they take what was read (white-
 * labelled `WebsiteDetail`s, the presenting agency) and a translator, and return a string.
 *
 * Every value is escaped (`escapeHtml`); brand colours must be `#rrggbb`; images are the documents' own CDN URLs
 * (the renderer refuses any other origin). No script, no web fonts: the renderer runs offline with JavaScript off.
 */
import type { WebsiteDetail, WebsiteImage, WebsitePresenter } from '@inmolink/contracts';
import type { Translate } from '@inmolink/i18n/server';
import { escapeHtml } from '../../email-text';

/** Formats amounts and dates in the document's locale. */
export interface DocFormat {
  locale: string;
  money(cents: number, currency: string): string;
  date(at: Date): string;
  dateTime(at: Date): string;
  number(n: number): string;
}

export function docFormat(locale: string, timeZone = 'Europe/Madrid'): DocFormat {
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const d = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone });
  const dt = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone });
  return {
    locale,
    money: (cents, currency) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100),
    date: (at) => d.format(at),
    dateTime: (at) => dt.format(at),
    number: (x) => n.format(x),
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_PRIMARY = '#1f3a5f';
const DEFAULT_ACCENT = '#c8a45d';
const color = (c: string | null, fallback: string) => (c && HEX.test(c) ? c : fallback);
const e = (s: string | number | null | undefined) => escapeHtml(String(s ?? ''));

/** Characters of a description on a portfolio page (a brochure shows it whole). */
const PORTFOLIO_TEXT_MAX = 900;
const BROCHURE_PHOTOS = 6;
const PORTFOLIO_PHOTOS = 3;

function css(presenter: WebsitePresenter): string {
  const primary = color(presenter.primaryColor, DEFAULT_PRIMARY);
  const accent = color(presenter.accentColor, DEFAULT_ACCENT);
  return `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; color: #1d232b; font-size: 10.5pt; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 210mm; height: 297mm; padding: 14mm 14mm 22mm; position: relative; overflow: hidden; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
.band { background: ${primary}; color: #fff; margin: -14mm -14mm 8mm; padding: 7mm 14mm; display: flex; justify-content: space-between; align-items: center; }
.band .agency { font-size: 14pt; font-weight: 700; letter-spacing: .02em; }
.band .contact { font-size: 9pt; text-align: right; opacity: .92; }
h1 { font-size: 20pt; line-height: 1.2; margin: 0 0 2mm; }
h2 { font-size: 12pt; margin: 6mm 0 2mm; color: ${primary}; border-bottom: .4mm solid ${accent}; padding-bottom: 1mm; }
.meta { color: #5b6573; font-size: 9.5pt; margin-bottom: 4mm; }
.badge { display: inline-block; background: ${accent}; color: #1d232b; border-radius: 1mm; padding: .6mm 2mm; font-size: 8.5pt; font-weight: 700; margin-right: 2mm; }
.price { font-size: 17pt; font-weight: 700; color: ${primary}; margin: 2mm 0 4mm; }
.hero { width: 100%; height: 95mm; object-fit: cover; border-radius: 1.5mm; background: #e8ebef; display: block; }
.hero.small { height: 78mm; }
.facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2mm; margin: 4mm 0; }
.fact { background: #f3f5f8; border-radius: 1.2mm; padding: 2mm 2.5mm; }
.fact .k { font-size: 8pt; color: #5b6573; text-transform: uppercase; letter-spacing: .04em; }
.fact .v { font-size: 11pt; font-weight: 700; }
.text { white-space: pre-line; text-align: justify; }
.features { columns: 3; column-gap: 6mm; padding-left: 4mm; margin: 0; font-size: 9.5pt; }
.photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2mm; margin-top: 4mm; }
.photos img { width: 100%; height: 38mm; object-fit: cover; border-radius: 1mm; background: #e8ebef; }
.footer { position: absolute; left: 14mm; right: 14mm; bottom: 8mm; font-size: 7.5pt; color: #7a8492; border-top: .3mm solid #d9dee4; padding-top: 2mm; display: flex; justify-content: space-between; }
.cover { display: flex; flex-direction: column; justify-content: center; height: 100%; }
.cover h1 { font-size: 28pt; color: ${primary}; }
.cover .count { font-size: 13pt; color: #5b6573; margin-top: 3mm; }
.cover .rule { width: 40mm; height: 1.2mm; background: ${accent}; margin: 8mm 0; }
table.terms { width: 100%; border-collapse: collapse; margin-top: 4mm; }
table.terms th { text-align: left; width: 45%; font-weight: 600; color: #5b6573; padding: 2.2mm 2mm; border-bottom: .3mm solid #e1e5ea; vertical-align: top; }
table.terms td { padding: 2.2mm 2mm; border-bottom: .3mm solid #e1e5ea; font-weight: 600; }
.note { margin-top: 8mm; font-size: 9pt; color: #5b6573; }
`;
}

function contactLine(p: WebsitePresenter): string {
  return [p.phone, p.email, p.website]
    .filter((x): x is string => !!x)
    .map(e)
    .join(' · ');
}

function band(p: WebsitePresenter): string {
  return `<div class="band"><div class="agency">${e(p.name)}</div><div class="contact">${contactLine(p)}</div></div>`;
}

function footer(p: WebsitePresenter, t: Translate, f: DocFormat, asOf: Date): string {
  return `<div class="footer"><span>${e(t('footer.asOf', { date: f.date(asOf) }))}</span><span>${e(p.name)}</span></div>`;
}

function doc(title: string, lang: string, presenter: WebsitePresenter, body: string): string {
  return `<!doctype html><html lang="${e(lang)}"><head><meta charset="utf-8"><title>${e(title)}</title><style>${css(presenter)}</style></head><body>${body}</body></html>`;
}

/**
 * An image URL, only when it is an absolute http(s) URL (the CDN's); anything else shows nothing. The renderer refuses
 * every origin but the allowed asset origins anyway.
 */
function src(image: WebsiteImage | null | undefined, size: 'large' | 'medium' | 'small'): string | null {
  const url = image?.urls[size] ?? image?.urls.large ?? image?.urls.medium ?? null;
  return url && /^https?:\/\//.test(url) ? url : null;
}

const img = (url: string | null, cls: string) =>
  url ? `<img class="${cls}" src="${e(url)}" alt="">` : `<div class="${cls}"></div>`;

function priceText(d: WebsiteDetail, t: Translate, f: DocFormat): string {
  const p = d.price;
  if (p.onRequest || p.amountCents === null) return t('listing.priceOnRequest');
  const amount = f.money(p.amountCents, p.currency);
  if (p.period) return t(`listing.perPeriod.${p.period}`, { price: amount });
  if (d.kind === 'LISTING' && d.priceToCents !== null && d.priceToCents > p.amountCents) {
    return t('listing.priceFrom', { price: amount });
  }
  return amount;
}

function placeText(d: WebsiteDetail): string {
  const pl = d.place;
  return [pl.area?.name, pl.city?.name, pl.region?.name].filter((x): x is string => !!x).join(', ');
}

function badges(d: WebsiteDetail, t: Translate): string {
  const out: string[] = [];
  if (d.kind === 'LISTING') out.push(t(`listing.transaction.${d.transactionType}`));
  if (d.status !== 'ACTIVE' && d.status !== 'AVAILABLE') {
    const label = t(`listing.status.${d.status}`);
    if (!label.startsWith('documents.')) out.push(label);
  }
  return out.map((b) => `<span class="badge">${e(b)}</span>`).join('');
}

function facts(d: WebsiteDetail, t: Translate, f: DocFormat): string {
  const area = (m2: number | null) => (m2 === null ? null : `${f.number(m2)} m²`);
  const rows: [string, string | null][] = [
    [t('listing.bedrooms'), d.bedrooms === null ? null : String(d.bedrooms)],
    [t('listing.bathrooms'), d.bathrooms === null ? null : String(d.bathrooms)],
    d.kind === 'LISTING' ? [t('listing.builtArea'), area(d.builtM2)] : [t('listing.internalArea'), area(d.internalM2)],
    [t('listing.plot'), area(d.plotM2)],
    [t('listing.terrace'), area(d.terraceM2)],
  ];
  if (d.kind === 'LISTING') {
    rows.push([t('listing.yearBuilt'), d.yearBuilt === null ? null : String(d.yearBuilt)]);
    rows.push([t('listing.energyRating'), d.energyRating]);
  }
  const shown = rows.filter((r): r is [string, string] => r[1] !== null).slice(0, 8);
  if (shown.length === 0) return '';
  return `<div class="facts">${shown.map(([k, v]) => `<div class="fact"><div class="k">${e(k)}</div><div class="v">${e(v)}</div></div>`).join('')}</div>`;
}

function photos(d: WebsiteDetail, count: number): string {
  if (d.kind !== 'LISTING') return '';
  const urls = d.media
    .filter((m): m is WebsiteImage => m.kind !== 'VIDEO' && !m.cover)
    .map((m) => src(m, 'medium'))
    .filter((u): u is string => u !== null)
    .slice(0, count);
  if (urls.length === 0) return '';
  return `<div class="photos">${urls.map((u) => `<img src="${e(u)}" alt="">`).join('')}</div>`;
}

function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

function heading(d: WebsiteDetail, t: Translate, f: DocFormat): string {
  const place = placeText(d);
  const ref = t('listing.reference', { ref: d.ref });
  const development = d.kind === 'UNIT' ? ` · ${e(t('listing.development', { name: d.development.name }))}` : '';
  return `<div>${badges(d, t)}</div><h1>${e(d.title)}</h1><div class="meta">${e(ref)}${place ? ` · ${e(place)}` : ''}${development}</div><div class="price">${e(priceText(d, t, f))}</div>`;
}

function listingPage(
  d: WebsiteDetail,
  presenter: WebsitePresenter,
  t: Translate,
  f: DocFormat,
  asOf: Date,
  mode: 'brochure' | 'portfolio',
): string {
  const text = d.description ? (mode === 'portfolio' ? cutText(d.description, PORTFOLIO_TEXT_MAX) : d.description) : '';
  const features =
    mode === 'brochure' && d.kind === 'LISTING' && d.features.length > 0
      ? `<h2>${e(t('listing.features'))}</h2><ul class="features">${d.features.map((x) => `<li>${e(x.name)}</li>`).join('')}</ul>`
      : '';
  return `<section class="page">${band(presenter)}${heading(d, t, f)}${img(d.kind === 'LISTING' ? src(d.cover, mode === 'portfolio' ? 'medium' : 'large') : null, mode === 'portfolio' ? 'hero small' : 'hero')}${facts(d, t, f)}${
    text ? `<h2>${e(t('listing.description'))}</h2><div class="text">${e(text)}</div>` : ''
  }${features}${photos(d, mode === 'portfolio' ? PORTFOLIO_PHOTOS : BROCHURE_PHOTOS)}${footer(presenter, t, f, asOf)}</section>`;
}

export interface ListingsDocInput {
  presenter: WebsitePresenter;
  items: readonly WebsiteDetail[];
  t: Translate;
  format: DocFormat;
  asOf: Date;
}

/** One listing: its page (photos, facts, the whole description, features), branded. */
export function brochureHtml(input: ListingsDocInput): string {
  const [d] = input.items;
  if (!d) throw new TypeError('brochure: no listing');
  return doc(
    d.title,
    input.format.locale,
    input.presenter,
    listingPage(d, input.presenter, input.t, input.format, input.asOf, 'brochure'),
  );
}

/** A cover (title, count, agency), then one page per listing in the given order. */
export function portfolioHtml(input: ListingsDocInput & { title: string | null }): string {
  const { presenter, t, format: f } = input;
  const title = input.title ?? t('portfolio.defaultTitle');
  const cover = `<section class="page">${band(presenter)}<div class="cover"><h1>${e(title)}</h1><div class="count">${e(
    t('portfolio.count', { count: input.items.length }),
  )}</div><div class="rule"></div><div class="meta">${e(presenter.name)}<br>${contactLine(presenter)}<br>${e(f.date(input.asOf))}</div></div>${footer(presenter, t, f, input.asOf)}</section>`;
  const pages = input.items.map((d) => listingPage(d, presenter, t, f, input.asOf, 'portfolio')).join('');
  return doc(title, f.locale, presenter, cover + pages);
}

/** The accepted viewing terms (S11-02): what both agencies agreed for one viewing, with the audit trail. */
export interface ViewingTermsDocInput {
  requestId: string;
  target: { ref: string | null; title: string | null };
  introducerName: string;
  ownerName: string;
  commissionBp: number | null;
  commissionFixed: { amountCents: number; currency: string } | null;
  splitBp: number;
  includesVat: boolean;
  validUntil: Date;
  snapshotAt: Date;
  introducerAcceptedAt: Date;
  ownerAcceptedAt: Date;
  scheduledAt: Date | null;
  t: Translate;
  format: DocFormat;
}

export function viewingTermsHtml(input: ViewingTermsDocInput): string {
  const { t, format: f } = input;
  const percent = (bp: number) => `${f.number(bp / 100)} %`;
  const commission =
    input.commissionBp !== null
      ? t('viewingTerms.commissionPercent', { percent: percent(input.commissionBp) })
      : input.commissionFixed
        ? t('viewingTerms.commissionFixed', {
            amount: f.money(input.commissionFixed.amountCents, input.commissionFixed.currency),
          })
        : '—';
  const property = [input.target.ref, input.target.title].filter((x): x is string => !!x).join(' · ') || '—';
  const rows: [string, string][] = [
    [t('viewingTerms.request'), input.requestId],
    [t('viewingTerms.property'), property],
    [t('viewingTerms.introducer'), input.introducerName],
    [t('viewingTerms.owner'), input.ownerName],
    [t('viewingTerms.commission'), commission],
    [t('viewingTerms.split'), percent(input.splitBp)],
    [t('viewingTerms.vat'), t(input.includesVat ? 'viewingTerms.vatIncluded' : 'viewingTerms.vatExcluded')],
    [t('viewingTerms.validUntil'), f.date(input.validUntil)],
    [t('viewingTerms.snapshotAt'), f.dateTime(input.snapshotAt)],
    [t('viewingTerms.acceptedByIntroducer'), f.dateTime(input.introducerAcceptedAt)],
    [t('viewingTerms.acceptedByOwner'), f.dateTime(input.ownerAcceptedAt)],
    ...(input.scheduledAt ? [[t('viewingTerms.scheduledAt'), f.dateTime(input.scheduledAt)] as [string, string]] : []),
  ];
  const neutral: WebsitePresenter = {
    name: '',
    email: null,
    phone: null,
    whatsapp: null,
    website: null,
    primaryColor: null,
    accentColor: null,
  };
  const body = `<section class="page"><h1>${e(t('viewingTerms.title'))}</h1><div class="meta">${e(t('viewingTerms.subtitle'))}</div><table class="terms">${rows
    .map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`)
    .join('')}</table><div class="note">${e(t('viewingTerms.auditNote'))}</div></section>`;
  return doc(t('viewingTerms.title'), f.locale, neutral, body);
}
