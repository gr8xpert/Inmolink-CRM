/**
 * Form templates (R2-05a): complete HTML documents for the `pdf` renderer — listing agreement, reservation, viewing
 * sheet, offer and collaboration agreement. Pure: they take a form's stored data (`FormData`), a translator and a
 * formatter, and return a string. Every value is escaped; brand colours must be `#rrggbb`; no script, no web fonts, no
 * remote asset (the renderer runs offline with JavaScript off).
 *
 * Clause texts are the `documents` messages `forms.<template>.clauses.*` — PLACEHOLDERS written for layout, pending
 * lawyer review (STATUS Decisions, H17): every document carries the `forms.placeholderNotice` banner until they are
 * replaced (and `FORM_TEMPLATE_VERSION` bumped). Prices, deposits, offers and commission are the data's, formatted —
 * never typed into a clause.
 */
import { FORM_SIGNER_ROLES, type FormTemplate } from '@inmolink/contracts';
import type { Translate } from '@inmolink/i18n/server';
import { escapeHtml } from '../../email-text';
import type { FormAgency, FormClient, FormCommission, FormData, FormProperty } from './forms-data';
import type { DocFormat } from './templates';

/** Clauses of each template (`forms.<template>.clauses.c1` … `cN`). */
export const FORM_CLAUSES: Readonly<Record<FormTemplate, number>> = {
  LISTING_AGREEMENT: 5,
  RESERVATION: 5,
  VIEWING_SHEET: 3,
  OFFER: 4,
  COLLABORATION_AGREEMENT: 5,
};

/** Who signs each template, in order (`forms.signers.*`); R2-05b signs these blocks (`data-signer`). */
export const FORM_SIGNERS = FORM_SIGNER_ROLES;

const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (c: string | null, fallback: string) => (c && HEX.test(c) ? c : fallback);
const e = (s: string | number | null | undefined) => escapeHtml(String(s ?? ''));

function css(agency: FormAgency): string {
  const primary = color(agency.primaryColor, '#1f3a5f');
  const accent = color(agency.accentColor, '#c8a45d');
  return `
@page { size: A4; margin: 14mm 14mm 18mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; color: #1d232b; font-size: 10pt; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.band { background: ${primary}; color: #fff; padding: 5mm 6mm; display: flex; justify-content: space-between; align-items: center; border-radius: 1.2mm; }
.band .agency { font-size: 13pt; font-weight: 700; }
.band .contact { font-size: 8.5pt; text-align: right; opacity: .92; }
.placeholder { margin: 4mm 0; padding: 2.5mm 3mm; border: .5mm dashed #b42318; color: #b42318; font-weight: 700; font-size: 9pt; text-transform: uppercase; letter-spacing: .02em; }
h1 { font-size: 18pt; margin: 5mm 0 1mm; color: ${primary}; }
.meta { color: #5b6573; font-size: 9pt; margin-bottom: 3mm; }
h2 { font-size: 11pt; margin: 5mm 0 2mm; color: ${primary}; border-bottom: .4mm solid ${accent}; padding-bottom: 1mm; }
table.kv { width: 100%; border-collapse: collapse; }
table.kv th { text-align: left; width: 38%; font-weight: 600; color: #5b6573; padding: 1.6mm 2mm; border-bottom: .3mm solid #e1e5ea; vertical-align: top; }
table.kv td { padding: 1.6mm 2mm; border-bottom: .3mm solid #e1e5ea; }
table.list { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
table.list th, table.list td { text-align: left; padding: 1.6mm 2mm; border-bottom: .3mm solid #e1e5ea; }
table.list th { color: #5b6573; font-weight: 600; }
ol.clauses { padding-left: 5mm; margin: 0; }
ol.clauses li { margin-bottom: 2mm; text-align: justify; }
.conditions { white-space: pre-line; border-left: .8mm solid ${accent}; padding-left: 3mm; }
.sigs { display: flex; gap: 8mm; margin-top: 10mm; break-inside: avoid; }
.sig { flex: 1; }
.sig .who { font-size: 8.5pt; color: #5b6573; text-transform: uppercase; letter-spacing: .04em; }
.sig .name { font-weight: 700; margin-top: 1mm; }
.sig .line { height: 18mm; border-bottom: .3mm solid #1d232b; }
.sig .k { font-size: 8pt; color: #5b6573; margin-top: 1mm; }
.footer { margin-top: 8mm; font-size: 7.5pt; color: #7a8492; border-top: .3mm solid #d9dee4; padding-top: 2mm; display: flex; justify-content: space-between; }
`;
}

function contactLine(a: FormAgency): string {
  return [a.phone, a.email, a.website]
    .filter((x): x is string => !!x)
    .map(e)
    .join(' · ');
}

function kv(rows: readonly (readonly [string, string | null])[], t: Translate): string {
  return `<table class="kv">${rows
    .map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v ?? t('forms.common.notStated'))}</td></tr>`)
    .join('')}</table>`;
}

function agencyRows(a: FormAgency, t: Translate): [string, string | null][] {
  return [
    [t('forms.common.name'), a.name],
    [t('forms.common.taxId'), a.taxId],
    [t('forms.common.address'), a.address],
    [t('forms.common.registerNumber'), a.registerNumber],
  ];
}

function clientRows(c: FormClient, t: Translate): [string, string | null][] {
  return [
    [t('forms.common.name'), c.name],
    // the identity document is written in by hand (or by the signer, R2-05b): the CRM does not keep it
    [t('forms.common.idDocument'), null],
    [t('forms.common.email'), c.email],
    [t('forms.common.phone'), c.phone],
  ];
}

/**
 * The property. The cadastral reference identifies the owner on the Catastro: only the owner's own listing agreement
 * shows it, never a document a buyer keeps.
 */
function propertyRows(p: FormProperty, t: Translate, f: DocFormat, cadastral = false): [string, string | null][] {
  return [
    [t('forms.common.reference'), p.reference],
    [t('forms.common.property'), p.title],
    ...(cadastral ? [[t('forms.common.cadastralRef'), p.cadastralRef] as [string, string | null]] : []),
    [t('forms.common.transaction'), t(`listing.transaction.${p.transactionType}`)],
    [t('forms.common.askingPrice'), p.price ? f.exactMoney(p.price.amountCents, p.price.currency) : null],
  ];
}

const percent = (bp: number, f: DocFormat) => `${f.number(bp / 100)} %`;

function commissionText(c: FormCommission, t: Translate, f: DocFormat): string {
  const amount =
    c.bp !== null
      ? t('forms.common.commissionPercent', { percent: percent(c.bp, f) })
      : c.fixed
        ? f.exactMoney(c.fixed.amountCents, c.fixed.currency)
        : t('forms.common.notStated');
  return `${amount} · ${t(c.includesVat ? 'forms.common.vatIncluded' : 'forms.common.vatExcluded')}`;
}

function clauses(template: FormTemplate, t: Translate, values: Record<string, string | number>): string {
  const items = Array.from({ length: FORM_CLAUSES[template] }, (_, i) =>
    t(`forms.${template}.clauses.c${i + 1}`, values),
  );
  return `<h2>${e(t('forms.common.clauses'))}</h2><ol class="clauses">${items.map((c) => `<li>${e(c)}</li>`).join('')}</ol>`;
}

function signatures(template: FormTemplate, names: readonly string[], t: Translate): string {
  return `<div class="sigs">${FORM_SIGNERS[template]
    .map(
      (role, i) =>
        `<div class="sig" data-signer="${e(role)}"><div class="who">${e(t(`forms.signers.${role}`))}</div><div class="name">${e(names[i] ?? '')}</div><div class="line"></div><div class="k">${e(t('forms.common.signatureDate'))}</div></div>`,
    )
    .join('')}</div>`;
}

export interface FormHtmlInput {
  documentId: string;
  data: FormData;
  t: Translate;
  format: DocFormat;
  templateVersion: number;
}

/** The complete HTML of a form document. */
export function formHtml(input: FormHtmlInput): string {
  const { data: d, t, format: f } = input;
  const generatedAt = new Date(d.generatedAt);
  const money = (m: { amountCents: number; currency: string }) => f.exactMoney(m.amountCents, m.currency);
  let body: string;
  switch (d.template) {
    case 'LISTING_AGREEMENT':
      body =
        `<h2>${e(t('forms.common.agency'))}</h2>${kv(agencyRows(d.agency, t), t)}` +
        `<h2>${e(t('forms.signers.seller'))}</h2>${kv(clientRows(d.client, t), t)}` +
        `<h2>${e(t('forms.common.property'))}</h2>${kv(propertyRows(d.property, t, f, true), t)}` +
        `<h2>${e(t('forms.common.terms'))}</h2>${kv(
          [
            [
              t('forms.LISTING_AGREEMENT.mandate'),
              t(d.exclusive ? 'forms.LISTING_AGREEMENT.exclusive' : 'forms.LISTING_AGREEMENT.open'),
            ],
            [t('forms.LISTING_AGREEMENT.term'), t('forms.common.months', { count: d.termMonths })],
            [t('forms.common.commission'), commissionText(d.commission, t, f)],
          ],
          t,
        )}` +
        clauses(d.template, t, { months: d.termMonths }) +
        signatures(d.template, [d.client.name, d.agency.name], t);
      break;
    case 'RESERVATION':
      body =
        `<h2>${e(t('forms.common.agency'))}</h2>${kv(agencyRows(d.agency, t), t)}` +
        `<h2>${e(t('forms.signers.buyer'))}</h2>${kv(clientRows(d.client, t), t)}` +
        `<h2>${e(t('forms.common.property'))}</h2>${kv(propertyRows(d.property, t, f), t)}` +
        `<h2>${e(t('forms.common.terms'))}</h2>${kv(
          [
            [t('forms.RESERVATION.price'), money(d.price)],
            [t('forms.RESERVATION.deposit'), money(d.deposit)],
            [t('forms.RESERVATION.hold'), t('forms.common.days', { count: d.holdDays })],
          ],
          t,
        )}` +
        clauses(d.template, t, { days: d.holdDays }) +
        signatures(d.template, [d.client.name, d.agency.name], t);
      break;
    case 'VIEWING_SHEET':
      body =
        `<h2>${e(t('forms.common.agency'))}</h2>${kv(agencyRows(d.agency, t), t)}` +
        `<h2>${e(t('forms.signers.buyer'))}</h2>${kv(clientRows(d.client, t), t)}` +
        `<h2>${e(t('forms.VIEWING_SHEET.visited', { date: f.date(new Date(`${d.visitedOn}T12:00:00Z`)) }))}</h2>` +
        `<table class="list"><tr><th>${e(t('forms.common.reference'))}</th><th>${e(t('forms.common.property'))}</th><th>${e(
          t('forms.common.askingPrice'),
        )}</th></tr>${d.properties
          .map(
            (p) =>
              `<tr><td>${e(p.reference)}</td><td>${e(p.title ?? '')}</td><td>${e(p.price ? money(p.price) : t('forms.common.notStated'))}</td></tr>`,
          )
          .join('')}</table>` +
        clauses(d.template, t, { count: d.properties.length }) +
        signatures(d.template, [d.client.name, d.agency.name], t);
      break;
    case 'OFFER':
      body =
        `<h2>${e(t('forms.common.agency'))}</h2>${kv(agencyRows(d.agency, t), t)}` +
        `<h2>${e(t('forms.signers.buyer'))}</h2>${kv(clientRows(d.client, t), t)}` +
        `<h2>${e(t('forms.common.property'))}</h2>${kv(propertyRows(d.property, t, f), t)}` +
        `<h2>${e(t('forms.common.terms'))}</h2>${kv(
          [
            [t('forms.OFFER.amount'), money(d.offer)],
            [t('forms.OFFER.validUntil'), f.date(new Date(`${d.validUntil}T12:00:00Z`))],
          ],
          t,
        )}` +
        (d.conditions
          ? `<h2>${e(t('forms.OFFER.conditions'))}</h2><div class="conditions">${e(d.conditions)}</div>`
          : '') +
        clauses(d.template, t, {}) +
        signatures(d.template, [d.client.name, d.agency.name], t);
      break;
    case 'COLLABORATION_AGREEMENT': {
      const own = d.agency.name;
      const ownerName = d.party === 'OWNER' ? own : d.counterpart.name;
      const introducerName = d.party === 'INTRODUCER' ? own : d.counterpart.name;
      const c = d.commission;
      body =
        `<h2>${e(t('forms.common.parties'))}</h2>${kv(
          [
            [t('forms.signers.ownerAgency'), ownerName],
            [t('forms.signers.introducerAgency'), introducerName],
            [t('forms.COLLABORATION_AGREEMENT.issuedBy'), own],
            [t('forms.common.taxId'), d.agency.taxId],
            [t('forms.common.registerNumber'), d.agency.registerNumber],
          ],
          t,
        )}` +
        `<h2>${e(t('forms.common.property'))}</h2>${kv(
          [
            [t('forms.common.reference'), d.property?.reference ?? null],
            [t('forms.common.property'), d.property?.title ?? null],
            [t('forms.COLLABORATION_AGREEMENT.deal'), d.dealId],
          ],
          t,
        )}` +
        `<h2>${e(t('forms.common.terms'))}</h2>${kv(
          [
            [t('forms.COLLABORATION_AGREEMENT.price'), money(d.price)],
            [
              t('forms.common.commission'),
              commissionText(
                { bp: d.terms.commissionBp, fixed: d.terms.commissionFixed, includesVat: d.terms.includesVat },
                t,
                f,
              ),
            ],
            [t('forms.COLLABORATION_AGREEMENT.split'), percent(d.terms.splitBp, f)],
            [t('forms.COLLABORATION_AGREEMENT.total'), f.exactMoney(c.totalCents, c.currency)],
            [t('forms.COLLABORATION_AGREEMENT.ownerShare'), f.exactMoney(c.ownerShareCents, c.currency)],
            [t('forms.COLLABORATION_AGREEMENT.introducerShare'), f.exactMoney(c.introducerShareCents, c.currency)],
          ],
          t,
        )}` +
        clauses(d.template, t, {}) +
        signatures(d.template, [ownerName, introducerName], t);
      break;
    }
  }
  const title = t(`forms.${d.template}.title`);
  const header =
    `<div class="band"><div class="agency">${e(d.agency.name)}</div><div class="contact">${contactLine(d.agency)}</div></div>` +
    `<div class="placeholder">${e(t('forms.placeholderNotice'))}</div>` +
    `<h1>${e(title)}</h1><div class="meta">${e(t(`forms.${d.template}.subtitle`))}</div>`;
  const footer = `<div class="footer"><span>${e(
    t('forms.common.footer', { id: input.documentId, version: input.templateVersion }),
  )}</span><span>${e(f.dateTime(generatedAt))}</span></div>`;
  return `<!doctype html><html lang="${e(f.locale)}"><head><meta charset="utf-8"><title>${e(title)}</title><style>${css(d.agency)}</style></head><body>${header}${body}${footer}</body></html>`;
}
