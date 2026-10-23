import { WebsiteDetail } from '@inmolink/contracts';
import { XmlWriter } from '@inmolink/platform/xml';
import { describe, expect, it } from 'vitest';
import {
  type FeedItem,
  writeGenericEnd,
  writeGenericItem,
  writeGenericStart,
  writeKyeroEnd,
  writeKyeroProperty,
  writeKyeroStart,
} from '../../../feed-xml';
import { GENERIC_XSD, KYERO_XSD, schemaErrors } from './feed-schema';

/**
 * Per-site XML feed documents (S7-07): the Kyero v3 and generic writers against their schema fixtures
 * (`tests/fixtures/kyero/kyero-v3.xsd`, `tests/fixtures/website-feed/inmolink-feed-v1.xsd`), validated by libxml2
 * (xmllint-wasm). The integration test (`site-feeds.int.test.ts`) validates generated feeds the same way.
 */

const taxon = (name: string) => ({ id: '0195f0a5-0000-7000-8000-000000000001', name, slug: name.toLowerCase() });
const agency = {
  name: 'Costa Homes',
  email: 'hello@costa.example',
  phone: '+34 600 000 000',
  whatsapp: null,
  website: null,
  primaryColor: null,
  accentColor: null,
};
const image = (n: number) => ({
  kind: 'IMAGE' as const,
  cover: n === 1,
  alt: `View ${n} <b>&</b>`,
  room: null,
  width: 1600,
  height: 1067,
  urls: { large: `https://media.example/v1/abc${n}/large.webp`, thumb: `https://media.example/v1/abc${n}/thumb.webp` },
});

const listing = (over: Record<string, unknown> = {}) =>
  WebsiteDetail.parse({
    kind: 'LISTING',
    id: '0195f0a5-0000-7000-8000-0000000000a1',
    ref: 'CH-7K3M9QX2',
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 125_000_050, currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon('Villa'),
    place: {
      country: taxon('Spain'),
      region: taxon('Málaga'),
      city: taxon('Marbella'),
      area: taxon('Nueva Andalucía'),
    },
    bedrooms: 5,
    bathrooms: 4,
    builtM2: 420.5,
    plotM2: 1500,
    geo: { lat: 36.5071, lng: -4.9573, precision: 'APPROX' },
    cover: image(1),
    imageCount: 2,
    developmentId: null,
    title: 'Villa "Sol" & sea <views>',
    slug: 'villa-sol-sea-views',
    textLocale: null,
    description: 'Line one.\nLine two with ]]> and <script>alert(1)</script> & control \u0007 chars.',
    metaTitle: null,
    metaDescription: null,
    terraceM2: 80,
    yearBuilt: 2015,
    energyRating: 'B',
    energyEmissionsRating: 'EXEMPT',
    features: [taxon('Private pool'), taxon('Sea views')],
    media: [image(1), image(2)],
    developmentRef: null,
    agency,
    ...over,
  });

const unit = WebsiteDetail.parse({
  kind: 'UNIT',
  id: '0195f0a5-0000-7000-8000-0000000000b1',
  ref: 'CH-8M2N4P6R',
  status: 'AVAILABLE',
  price: { amountCents: 39_900_000, currency: 'EUR', period: null, onRequest: false },
  propertyType: taxon('Apartment'),
  place: { country: taxon('Spain'), region: taxon('Málaga'), city: taxon('Estepona'), area: null },
  bedrooms: 2,
  bathrooms: 2,
  internalM2: 96,
  terraceM2: 20,
  plotM2: null,
  floor: 3,
  orientation: 'SW',
  geo: null,
  development: {
    id: '0195f0a5-0000-7000-8000-0000000000c1',
    name: 'Sea Breeze',
    status: 'UNDER_CONSTRUCTION',
    completionDate: '2027-06-30',
    ref: 'CH-9Q8R7S6T',
  },
  title: 'Sea Breeze',
  slug: 'sea-breeze',
  textLocale: null,
  description: 'Two-bedroom apartment.',
  paymentTerms: '30 % on reservation',
  metaTitle: null,
  metaDescription: null,
  phase: null,
  agency,
});

const item = (base: WebsiteDetail, texts: [string, WebsiteDetail][] = [['en', base]]): FeedItem => ({
  base,
  texts: new Map(texts),
  updatedAt: new Date('2026-10-21T08:30:00Z'),
});

function kyeroOf(items: FeedItem[]): { xml: string; written: number } {
  const w = new XmlWriter();
  writeKyeroStart(w);
  const written = items.filter((i) => writeKyeroProperty(w, i)).length;
  writeKyeroEnd(w);
  return { xml: w.end(), written };
}

function genericOf(items: FeedItem[]): string {
  const w = new XmlWriter();
  writeGenericStart(w, {
    generatedAt: new Date('2026-10-21T09:00:00Z'),
    siteName: 'Costa',
    locales: ['en', 'es'],
    agency,
  });
  for (const i of items) writeGenericItem(w, i);
  writeGenericEnd(w);
  return w.end();
}

const es = listing({ title: 'Villa Sol', slug: 'villa-sol', description: 'Villa con vistas al mar.' });

describe('per-site XML feed documents', () => {
  it('[S7-07] the Kyero feed validates against the Kyero schema fixture', async () => {
    const { xml, written } = kyeroOf([
      item(listing(), [
        ['en', listing()],
        ['es', es],
      ]),
      item(unit),
    ]);
    expect(written).toBe(2);
    expect(await schemaErrors(xml, KYERO_XSD)).toEqual([]);
    // The schema is enforced (not a no-op): a value Kyero does not know fails.
    expect(await schemaErrors(xml.replace('<price_freq>sale', '<price_freq>day'), KYERO_XSD)).not.toEqual([]);
    // Whole euros, Kyero's date, both languages, images in order, the unit as a new build.
    expect(xml).toContain('<price>1250001</price>');
    expect(xml).toContain('<date>2026-10-21 08:30:00</date>');
    expect(xml).toContain('<es>Villa con vistas al mar.</es>');
    expect(xml).toContain('<image id="2"><url>https://media.example/v1/abc2/large.webp</url></image>');
    expect(xml).toContain('<new_build>1</new_build>');
    expect(xml).toContain('<pool>1</pool>');
    expect(xml).toContain('<consumption>B</consumption><emissions>exempt</emissions>');
  });

  it('[S7-07] the generic feed validates against its schema and carries every shown field', async () => {
    const xml = genericOf([
      item(listing(), [
        ['en', listing()],
        ['es', es],
      ]),
      item(unit),
    ]);
    expect(await schemaErrors(xml, GENERIC_XSD)).toEqual([]);
    expect(xml).toContain('<price currency="EUR">125000050</price>');
    expect(xml).toContain('<text lang="es"><title>Villa Sol</title>');
    expect(xml).toContain('<development ref="CH-9Q8R7S6T" status="UNDER_CONSTRUCTION" completion="2027-06-30">');
    expect(xml).toContain('<name>Costa Homes</name>');
    // The site's reference only: the internal ids (the same on every site) never appear.
    expect(xml).not.toContain(listing().id);
    expect(xml).not.toContain(unit.id);
    expect(xml).not.toContain(unit.kind === 'UNIT' ? unit.development.id : 'x');
  });

  it('[S7-07] user text is escaped by the writer: no markup, CDATA end or control character gets through', async () => {
    const { xml } = kyeroOf([item(listing())]);
    const generic = genericOf([item(listing())]);
    for (const doc of [xml, generic]) {
      expect(doc).not.toContain('<script>');
      expect(doc).not.toContain(']]>');
      expect(doc).not.toContain('\u0007');
      expect(doc).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
    expect(generic).toContain('<title>Villa "Sol" &amp; sea &lt;views&gt;</title>');
  });

  it('[S7-07] Kyero leaves out what it cannot take; the generic feed keeps it', async () => {
    const onRequest = listing({ price: { amountCents: null, currency: 'EUR', period: null, onRequest: true } });
    const nightly = listing({
      transactionType: 'RENT_SHORT_TERM',
      price: { amountCents: 15_000, currency: 'EUR', period: 'NIGHT', onRequest: false },
    });
    const monthly = listing({
      transactionType: 'RENT_LONG_TERM',
      price: { amountCents: 180_050, currency: 'EUR', period: 'MONTH', onRequest: false },
    });
    const nowhere = listing({ place: { country: taxon('Spain'), region: null, city: null, area: null } });
    const items = [onRequest, nightly, monthly, nowhere].map((d) => item(d));
    const { xml, written } = kyeroOf(items);
    expect(written).toBe(1);
    expect(xml).toContain('<price_freq>month</price_freq><part_ownership>');
    expect(xml).toContain('<price>1801</price>');
    expect(await schemaErrors(xml, KYERO_XSD)).toEqual([]);
    const generic = genericOf(items);
    expect(await schemaErrors(generic, GENERIC_XSD)).toEqual([]);
    expect(generic.match(/<item /g)).toHaveLength(4);
    expect(generic).toContain('<price_on_request currency="EUR">true</price_on_request>');
  });
});
