import type { ListingDetailDoc, WebsitePresenter } from '@inmolink/contracts';
import * as presentations from '@inmolink/core/modules/presentations';
import * as websiteApi from '@inmolink/core/modules/website-api';
import type * as websites from '@inmolink/core/modules/websites';
import { whiteLabelLeaks } from '@inmolink/core/test';
import { formatter } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { describe, expect, it } from 'vitest';
import { renderGonePage, renderSelectionPage } from './page';

/**
 * The selection page's HTML (S12-04): white-labelled (the shared white-label check over the whole document), escaped,
 * without JavaScript, and built for the Lighthouse checks we can make statically (one inline sheet, sized images, a
 * language, a title, labelled fields, no blocking request).
 */

const AGENCY = '01900000-0000-7000-8000-0000000000a1';
const OWNER = '01900000-0000-7000-8000-0000000000b2';
const TARGET = '01900000-0000-7000-8000-0000000000c3';
const OWNER_NAME = 'Ownerhaus Fictiva Homes';
const OWNER_MAIL = 'ventas@ownerhaus-fictiva.example';
const OWNER_PHONE = '+34 955 512 345';
const OWNER_REF = 'K7RNAZ7K';

const PRESENTER: WebsitePresenter = {
  name: 'Presenting Homes',
  email: 'hello@presenting.example',
  phone: '+34 600 000 001',
  whatsapp: null,
  website: null,
  primaryColor: '#123456',
  accentColor: null,
};
const taxon = (name: string) => ({ id: '01900000-0000-7000-8000-0000000000d1', name, slug: name.toLowerCase() });

const doc: ListingDetailDoc = {
  kind: 'LISTING',
  id: TARGET,
  ref: OWNER_REF,
  status: 'ACTIVE',
  transactionType: 'SALE',
  price: { amountCents: 45_000_000, currency: 'EUR', period: null, onRequest: false },
  propertyType: taxon('Villa'),
  place: { country: taxon('Spain'), region: null, city: taxon('Nerja'), area: null },
  bedrooms: 3,
  bathrooms: 2,
  builtM2: 180,
  plotM2: null,
  geo: null,
  cover: {
    kind: 'IMAGE',
    cover: true,
    alt: `Pool of ${OWNER_NAME}`,
    room: null,
    width: 1600,
    height: 1200,
    variants: { small: 'v1/1/small.webp', medium: 'v1/1/medium.webp' },
  },
  imageCount: 1,
  developmentId: null,
  title: `${OWNER_NAME} villa`,
  slug: 'villa',
  textLocale: null,
  description: `Sunny villa with 3 bedrooms. Call ${OWNER_NAME} on ${OWNER_PHONE} or mail ${OWNER_MAIL}. Ref. ${OWNER_REF}.`,
  metaTitle: null,
  metaDescription: null,
  terraceM2: null,
  yearBuilt: 2010,
  priceToCents: null,
  communityFeeMonthCents: null,
  ibiYearCents: null,
  garbageTaxYearCents: null,
  energyRating: 'B',
  energyEmissionsRating: null,
  features: [taxon('Pool')],
  media: [],
} as unknown as ListingDetailDoc;

function render(notice?: { kind: 'liked' | 'sent' }) {
  const view: websites.SiteView = {
    site: { agencyId: AGENCY, referencePrefix: 'PH' },
    presenter: PRESENTER,
    mediaBaseUrl: 'https://media.example',
    owners: new Map([
      [
        OWNER,
        { names: [OWNER_NAME], emails: [OWNER_MAIL], phones: [OWNER_PHONE], hosts: ['ownerhaus-fictiva.example'] },
      ],
    ]),
  };
  const model = presentations.presentSelection({
    selection: {
      id: '01900000-0000-7000-8000-0000000000e1',
      agencyId: AGENCY,
      title: 'Villas for Ana <script>alert(1)</script>',
      message: 'Hi Ana,\nmy picks.',
      locale: 'en',
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      items: [
        { targetId: TARGET, position: 0, titleOverride: null, note: `<img src=x onerror=alert(1)> ${OWNER_NAME}` },
      ],
    },
    locale: 'en',
    view,
    rows: [
      {
        targetId: TARGET,
        ownerAgencyId: OWNER,
        publicCode: 'AB12CD34',
        developmentCode: null,
        developmentOwnRef: null,
        doc,
      },
    ],
  });
  return renderSelectionPage({
    model,
    branding: websiteApi.embedBranding(model.presenter),
    action: `/s/${'a'.repeat(43)}`,
    mediaOrigin: 'https://media.example',
    text: { t: translator('en', 'embed'), fmt: formatter('en') },
    ...(notice ? { notice } : {}),
    liked: new Set(),
  });
}

describe('selection page (S12-04)', () => {
  it('[S12-04] the page passes the white-label test: nothing of the owner in the whole document', () => {
    const html = render();
    expect(
      whiteLabelLeaks(html, {
        name: OWNER_NAME,
        email: OWNER_MAIL,
        domain: 'ownerhaus-fictiva.example',
        ref: OWNER_REF,
        phone: OWNER_PHONE,
        agencyId: OWNER,
      }),
    ).toEqual([]);
    expect(html).toContain('PH-AB12CD34');
    expect(html).toContain('Presenting Homes');
    expect(html).toContain('€450,000');
    expect(html).toContain('3 bedrooms');
  });

  it('[S12-04] every text is escaped: no tag from data reaches the page', () => {
    const html = render();
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror=');
  });

  it('[S12-04] no JavaScript and the static Lighthouse checks: lang, title, viewport, sized lazy images, labels', () => {
    const html = render();
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/^<!DOCTYPE html><html lang="en">/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    // One inline sheet, no blocking request; the first image eager with a size (no layout shift).
    expect(html.match(/<link rel="stylesheet"/g)).toBeNull();
    expect(Buffer.byteLength(html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '')).toBeLessThan(14_000);
    expect(html).toMatch(/<img [^>]*width="1600"[^>]*height="1200"/);
    expect(html).toMatch(/fetchpriority="high"/i);
    // Every field has a label; every button a text.
    const textareas = html.match(/<textarea/g)?.length ?? 0;
    expect(textareas).toBeGreaterThan(0);
    expect(html.match(/<label class="embed-field"><span>/g)?.length).toBe(textareas);
    expect(Buffer.byteLength(html)).toBeLessThan(60_000);
  });

  it('[S12-04] notices after a like or an enquiry; a gone link has its own page', () => {
    expect(render({ kind: 'liked' })).toContain('your agent can see you like this property');
    expect(render({ kind: 'sent' })).toContain('Presenting Homes has your message');
    const gone = renderGonePage({ lang: 'es', text: { t: translator('es', 'embed'), fmt: formatter('es') } });
    expect(gone).toContain('Esta selección ya no está disponible');
  });
});
