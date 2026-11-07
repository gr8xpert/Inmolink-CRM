import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FORM_TEMPLATES, type FormTemplate } from '@inmolink/contracts';
import { type Catalogs, translator } from '@inmolink/i18n/server';
import { describe, expect, it } from 'vitest';
import { FORM_TEMPLATE_VERSION, FormData } from '../forms-data';
import { FORM_CLAUSES, FORM_SIGNERS, formHtml } from '../forms-templates';
import { docFormat } from '../templates';

/** The documents catalogs as written (EN and ES are hand-written). */
const MESSAGES = fileURLToPath(new URL('../../../../../i18n/messages/', import.meta.url));
const raw = Object.fromEntries(
  ['en', 'es'].map((l) => [l, JSON.parse(readFileSync(`${MESSAGES}${l}/documents.json`, 'utf8'))]),
) as Record<'en' | 'es', { forms: Record<string, unknown> }>;
const catalogs = { en: { documents: raw.en }, es: { documents: raw.es } } as unknown as Catalogs;
const t = (locale: 'en' | 'es') => translator(locale, 'documents', { catalogs });

const ID = '01900000-0000-7000-8000-0000000000f1';
const agency = {
  name: 'Costa <Homes>',
  taxId: 'B12345678',
  address: 'Calle Mayor 1, 29600 Marbella',
  registerNumber: 'AICAT 1234',
  email: 'hello@costa.example',
  phone: '+34 600 000 000',
  website: 'https://costa.example',
  primaryColor: '#123456',
  accentColor: 'red; background:url(x)',
};
const client = {
  contactId: '01900000-0000-7000-8000-0000000000c1',
  name: 'Ana López',
  email: 'ana@x.example',
  phone: null,
};
const property = {
  listingId: '01900000-0000-7000-8000-0000000000a1',
  reference: 'CH-1001',
  title: 'Villa with sea views',
  cadastralRef: '1234567AB1234C0001XY',
  transactionType: 'SALE' as const,
  price: { amountCents: 45_000_050, currency: 'EUR' },
};
const common = { v: 1 as const, generatedAt: '2026-11-07T10:00:00.000Z', agency };

const samples: Record<FormTemplate, FormData> = {
  LISTING_AGREEMENT: {
    template: 'LISTING_AGREEMENT',
    ...common,
    client,
    property,
    commission: { bp: 350, fixed: null, includesVat: false },
    exclusive: true,
    termMonths: 6,
  },
  RESERVATION: {
    template: 'RESERVATION',
    ...common,
    client,
    property,
    price: { amountCents: 44_000_000, currency: 'EUR' },
    deposit: { amountCents: 600_050, currency: 'EUR' },
    holdDays: 15,
  },
  VIEWING_SHEET: {
    template: 'VIEWING_SHEET',
    ...common,
    client,
    properties: [
      property,
      { ...property, listingId: '01900000-0000-7000-8000-0000000000a2', reference: 'CH-1002', price: null },
    ],
    visitedOn: '2026-11-06',
  },
  OFFER: {
    template: 'OFFER',
    ...common,
    client,
    property,
    offer: { amountCents: 43_000_000, currency: 'EUR' },
    validUntil: '2026-11-20',
    conditions: 'Subject to a <mortgage>\nand a survey',
  },
  COLLABORATION_AGREEMENT: {
    template: 'COLLABORATION_AGREEMENT',
    ...common,
    dealId: '01900000-0000-7000-8000-0000000000d1',
    party: 'INTRODUCER',
    counterpart: { name: 'Sol Realty' },
    property: { reference: 'SR-77', title: 'Penthouse' },
    price: { amountCents: 58_000_001, currency: 'EUR' },
    terms: { commissionBp: 350, commissionFixed: null, splitBp: 6000, includesVat: true },
    commission: { totalCents: 2_030_000, introducerShareCents: 1_218_000, ownerShareCents: 812_000, currency: 'EUR' },
  },
};

const html = (template: FormTemplate, locale: 'en' | 'es') =>
  formHtml({
    documentId: ID,
    data: FormData.parse(samples[template]),
    t: t(locale),
    format: docFormat(locale),
    templateVersion: FORM_TEMPLATE_VERSION,
  });

/** Every key path of a message tree. */
function keys(tree: unknown, prefix = ''): string[] {
  if (typeof tree !== 'object' || tree === null) return [prefix];
  return Object.entries(tree).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('[R2-05a] form templates', () => {
  it('[R2-05a] EN and ES hold the same form messages, every clause each template shows, and no text is missing', () => {
    expect(keys(raw.es.forms).sort()).toEqual(keys(raw.en.forms).sort());
    for (const template of FORM_TEMPLATES) {
      for (let i = 1; i <= FORM_CLAUSES[template]; i++) {
        expect(keys(raw.en.forms), `${template} c${i}`).toContain(`${template}.clauses.c${i}`);
      }
      for (const locale of ['en', 'es'] as const) {
        const out = html(template, locale);
        // an unknown key renders as `documents.<key>`: none may be left
        expect(out, `${template} ${locale}`).not.toMatch(/documents\.(forms|listing)\./);
      }
    }
  });

  it('[R2-05a] every clause is a clearly marked placeholder and every document says so on its face', () => {
    for (const template of FORM_TEMPLATES) {
      for (let i = 1; i <= FORM_CLAUSES[template]; i++) {
        const clauses = (locale: 'en' | 'es') =>
          (raw[locale].forms[template] as { clauses: Record<string, string> }).clauses[`c${i}`];
        expect(clauses('en')).toMatch(/^\[PLACEHOLDER — pending lawyer review\] /);
        expect(clauses('es')).toMatch(/^\[TEXTO PROVISIONAL — pendiente de revisión jurídica\] /);
      }
      expect(html(template, 'en')).toContain('Draft clauses pending lawyer review');
      expect(html(template, 'es')).toContain('Cláusulas provisionales pendientes de revisión jurídica');
    }
  });

  it('[R2-05a] amounts, commission and parties come from the data, to the cent, in the document’s locale', () => {
    const listing = html('LISTING_AGREEMENT', 'en');
    expect(listing).toContain('€450,000.50');
    expect(listing).toContain('3.5 % of the price');
    expect(listing).toContain('6 months');
    expect(listing).toContain('1234567AB1234C0001XY');
    const reserva = html('RESERVATION', 'es');
    expect(reserva).toContain('6000,50');
    expect(reserva).toContain('440.000,00');
    expect(reserva).toContain('15 días');
    const collab = html('COLLABORATION_AGREEMENT', 'en');
    // the introducer issues it: the counterpart is the listing agency
    expect(collab).toMatch(/Listing agency<\/th><td>Sol Realty/);
    expect(collab).toMatch(/Collaborating agency<\/th><td>Costa &lt;Homes&gt;/);
    for (const amount of ['€580,000.01', '€20,300.00', '€12,180.00', '€8,120.00', '60 %']) {
      expect(collab).toContain(amount);
    }
    const sheet = html('VIEWING_SHEET', 'en');
    expect(sheet).toContain('CH-1001');
    expect(sheet).toContain('CH-1002');
    expect(sheet).toContain('the 2 properties');
  });

  it('[R2-05a] values are escaped, brand colours must be hex, no script and a signature block per signer', () => {
    const out = html('OFFER', 'en');
    expect(out).toContain('Costa &lt;Homes&gt;');
    expect(out).toContain('Subject to a &lt;mortgage&gt;');
    expect(out).not.toContain('<mortgage>');
    expect(out).not.toContain('url(x)');
    expect(out).toContain('#123456');
    expect(out).not.toMatch(/<script|<link|@import|https?:\/\/[^"<\s]*\.(css|js|woff)/i);
    for (const template of FORM_TEMPLATES) {
      const doc = html(template, 'en');
      for (const signer of FORM_SIGNERS[template]) expect(doc).toContain(`data-signer="${signer}"`);
      expect(doc).toContain(`Document ${ID} · template v${FORM_TEMPLATE_VERSION}`);
    }
  });
});
