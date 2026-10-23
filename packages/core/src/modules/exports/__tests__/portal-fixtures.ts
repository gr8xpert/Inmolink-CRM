import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ListingDetailDoc } from '@inmolink/contracts';
import { validateXML } from 'xmllint-wasm';
import type { OwnListingDetail } from '../../search';

/** Schema fixtures (`tests/fixtures`) and the libxml2 (xmllint-wasm) check, as the per-site feed tests do. */
const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'tests', 'fixtures');
export const xsd = (relative: string) => readFileSync(join(FIXTURES, relative), 'utf8');

export async function schemaErrors(xml: string, schema: string): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: 'feed.xml', contents: xml }],
    schema: [schema],
    maxMemoryPages: 16 * 1024,
  });
  return result.valid ? [] : result.errors.map((e) => e.rawMessage);
}

const taxon = (name: string, n = 1) => ({
  id: `0195f0a5-0000-7000-8000-00000000000${n}`,
  name,
  slug: name.toLowerCase().replace(/\W+/g, '-'),
});

type Image = NonNullable<ListingDetailDoc['cover']>;

export const image = (n: number): Image => ({
  kind: 'IMAGE',
  cover: n === 1,
  alt: `View ${n}`,
  room: null,
  width: 1600,
  height: 1067,
  variants: { large: `v1/img${n}/large.webp`, thumb: `v1/img${n}/thumb.webp` },
});

export const DESCRIPTION =
  'A bright villa a short walk from the beach, with a private pool, a large terrace and sea views from every bedroom. '.repeat(
    2,
  );

/** A complete document: valid for every portal profile (6 photos, CEE, description of 200+ characters). */
export function listingDoc(over: Partial<ListingDetailDoc> = {}): ListingDetailDoc {
  const media = Array.from({ length: 6 }, (_, i) => image(i + 1));
  return {
    kind: 'LISTING',
    id: '0195f0a5-0000-7000-8000-0000000000a1',
    ref: 'REF-1',
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 125_000_000, currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon('Villa', 2),
    place: {
      country: taxon('Spain', 3),
      region: taxon('Málaga', 4),
      city: taxon('Marbella', 5),
      area: null,
    },
    bedrooms: 4,
    bathrooms: 3,
    builtM2: 320,
    plotM2: 900,
    geo: { lat: 36.5, lng: -4.9, precision: 'APPROX' },
    cover: media[0] ?? null,
    imageCount: media.length,
    developmentId: null,
    title: 'Villa by the sea',
    slug: 'villa-by-the-sea',
    textLocale: null,
    description: DESCRIPTION,
    metaTitle: null,
    metaDescription: null,
    terraceM2: 60,
    yearBuilt: 2012,
    priceToCents: null,
    communityFeeMonthCents: null,
    ibiYearCents: null,
    garbageTaxYearCents: null,
    energyRating: 'C',
    energyEmissionsRating: 'B',
    features: [taxon('Private pool', 6), taxon('Sea views', 7)],
    media,
    ...over,
  } as ListingDetailDoc;
}

export const ownDetail = (
  targetId: string,
  doc: ListingDetailDoc,
  locale = 'en',
  updatedAt = new Date('2026-10-20T10:00:00Z'),
): OwnListingDetail => ({ targetId, locale, doc, updatedAt });

export const PRESENTER = {
  name: 'Costa Homes',
  email: 'hello@costa.example',
  phone: '+34 600 000 000',
  whatsapp: null,
  website: null,
  primaryColor: null,
  accentColor: null,
};
