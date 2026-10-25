import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WebsiteDetail, WebsitePresenter } from '@inmolink/contracts';
import { type Catalogs, translator } from '@inmolink/i18n/server';
import { describe, expect, it } from 'vitest';
import { brochureHtml, docFormat, portfolioHtml, viewingTermsHtml } from '../templates';

/** The documents catalogs as written (EN and ES are hand-written), read directly so the test needs no regenerated bundle. */
const MESSAGES = fileURLToPath(new URL('../../../../../i18n/messages/', import.meta.url));
const catalogs: Catalogs = Object.fromEntries(
  ['en', 'es'].map((l) => [l, { documents: JSON.parse(readFileSync(`${MESSAGES}${l}/documents.json`, 'utf8')) }]),
);
const t = (locale: 'en' | 'es') => translator(locale, 'documents', { catalogs });

const presenter: WebsitePresenter = {
  name: 'Costa Homes',
  email: 'hello@costa.example',
  phone: '+34 600 000 000',
  whatsapp: null,
  website: 'https://costa.example',
  primaryColor: '#123456',
  accentColor: 'red; background:url(x)',
};

const image = (n: number, cover = false) => ({
  kind: 'IMAGE' as const,
  cover,
  alt: null,
  room: null,
  width: 1600,
  height: 1067,
  urls: { large: `https://media.example/l/${n}.webp`, medium: `https://media.example/m/${n}.webp` },
});

function listing(over: Partial<Extract<WebsiteDetail, { kind: 'LISTING' }>> = {}): WebsiteDetail {
  return {
    kind: 'LISTING',
    id: '0195f0a5-0001-7000-8000-000000000001',
    ref: 'CH-1001',
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 45_000_000, currency: 'EUR', period: null, onRequest: false },
    propertyType: { id: '0195f0a5-0001-7000-8000-0000000000a1', name: 'Villa', slug: 'villa' },
    place: {
      country: null,
      region: { id: '0195f0a5-0001-7000-8000-0000000000b1', name: 'Andalucía', slug: 'andalucia' },
      city: { id: '0195f0a5-0001-7000-8000-0000000000b2', name: 'Marbella', slug: 'marbella' },
      area: null,
    },
    bedrooms: 4,
    bathrooms: 3,
    builtM2: 240,
    plotM2: 900,
    geo: null,
    cover: image(0, true),
    imageCount: 4,
    developmentId: null,
    developmentRef: null,
    title: 'Villa <script>alert(1)</script> with sea views',
    slug: 'villa',
    textLocale: null,
    description: 'Light & airy.\nSouth facing.',
    metaTitle: null,
    metaDescription: null,
    terraceM2: 60,
    yearBuilt: 2015,
    priceToCents: null,
    communityFeeMonthCents: null,
    ibiYearCents: null,
    garbageTaxYearCents: null,
    energyRating: 'B',
    energyEmissionsRating: null,
    features: [{ id: '0195f0a5-0001-7000-8000-0000000000c1', name: 'Pool', slug: 'pool' }],
    media: [image(0, true), image(1), image(2), image(3)],
    agency: presenter,
    ...over,
  } as WebsiteDetail;
}

const asOf = new Date('2026-10-25T10:00:00Z');

describe('PDF templates (S12-05)', () => {
  it('[S12-05] a brochure is branded and escapes every value; colours must be #rrggbb', () => {
    const html = brochureHtml({ presenter, items: [listing()], t: t('en'), format: docFormat('en'), asOf });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('Costa Homes');
    expect(html).toContain('background: #123456');
    // An invalid colour is replaced, never pasted into the CSS.
    expect(html).not.toContain('url(x)');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Light &amp; airy.');
    expect(html).toContain('€450,000');
    expect(html).toContain('Ref. CH-1001');
    expect(html).toContain('https://media.example/l/0.webp');
    expect(html).toContain('Pool');
    expect(html).not.toContain('<script');
  });

  it("[S12-05] locale-aware: labels, amounts and dates in the client's language", () => {
    const rent = listing({
      transactionType: 'RENT_LONG_TERM',
      price: { amountCents: 250_000, currency: 'EUR', period: 'MONTH', onRequest: false },
      status: 'UNDER_OFFER',
    });
    const es = brochureHtml({ presenter, items: [rent], t: t('es'), format: docFormat('es'), asOf });
    expect(es).toContain('lang="es"');
    expect(es).toContain('Dormitorios');
    expect(es).toContain('En alquiler');
    expect(es).toContain('Oferta en curso');
    expect(es).toMatch(/2500\s€ \/ mes/);
    expect(es).toContain('25 de octubre de 2026');
    const onRequest = listing({ price: { amountCents: null, currency: 'EUR', period: null, onRequest: true } });
    expect(brochureHtml({ presenter, items: [onRequest], t: t('en'), format: docFormat('en'), asOf })).toContain(
      'Price on request',
    );
  });

  it('[S12-05] a portfolio: a cover, then one page per listing in order', () => {
    const items = Array.from({ length: 5 }, (_, i) => listing({ ref: `CH-${i}`, title: `House ${i}` }));
    const html = portfolioHtml({ presenter, items, t: t('en'), format: docFormat('en'), asOf, title: null });
    expect(html.match(/<section class="page">/g)).toHaveLength(6);
    expect(html).toContain('A selection of properties for you');
    expect(html).toContain('5 properties');
    expect(html.indexOf('House 0')).toBeLessThan(html.indexOf('House 4'));
  });

  it('[S12-05] the accepted viewing terms: parties, commission, split, VAT and both acceptances', () => {
    const html = viewingTermsHtml({
      requestId: '0195f0a5-0001-7000-8000-000000000099',
      target: { ref: 'CH-1001', title: 'Villa in Marbella' },
      introducerName: 'Intro Realty',
      ownerName: 'Owner Estates',
      commissionBp: 400,
      commissionFixed: null,
      splitBp: 5000,
      includesVat: false,
      validUntil: new Date('2027-01-01T00:00:00Z'),
      snapshotAt: asOf,
      introducerAcceptedAt: asOf,
      ownerAcceptedAt: new Date('2026-10-26T09:30:00Z'),
      scheduledAt: null,
      t: t('en'),
      format: docFormat('en'),
    });
    for (const s of ['Intro Realty', 'Owner Estates', '4 % of the price', '50 %', 'Not included', 'CH-1001']) {
      expect(html).toContain(s);
    }
    expect(html).toContain('Accepted by the listing agency');
  });
});
