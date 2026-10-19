import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { XmlMappingInput } from '@inmolink/contracts';

/** The non-Kyero fixture feed (S6-04) and the mapping profile that reads it: what the visual mapper would save. */
export const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../../../tests/fixtures/xml-mapped/estate-export.xml', import.meta.url),
);
export const fixtureBytes = () => new Uint8Array(readFileSync(FIXTURE_PATH));

export const FIXTURE_MAPPING: XmlMappingInput = {
  schemaVersion: 1,
  recordElement: 'object',
  decimalSeparator: 'comma',
  fields: {
    ref: { path: '@code' },
    propertyType: { path: 'category' },
    transactionType: { path: 'deal', map: { venta: 'SALE', alquiler: 'RENT_LONG_TERM' } },
    price: { path: 'price' },
    currency: { path: 'price/@currency' },
    bedrooms: { path: 'rooms/bed' },
    bathrooms: { path: 'rooms/bath' },
    builtM2: { path: 'size/living' },
    plotM2: { path: 'size/plot' },
    latitude: { path: 'geo/@lat' },
    longitude: { path: 'geo/@lon' },
    country: { path: 'place/nation' },
    city: { path: 'place/town' },
  },
  features: [{ path: 'tags/tag' }],
  images: [{ path: 'photos/photo/@url' }],
  translations: [
    { locale: 'en', title: { path: 'title_en' }, description: { path: 'body_en' } },
    { locale: 'es', title: { path: 'title_es' }, description: { path: 'body_es' } },
  ],
};
