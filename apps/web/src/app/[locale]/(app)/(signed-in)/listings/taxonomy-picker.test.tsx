import type { ListingContentDto, ListingDto } from '@inmolink/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ListingEditor } from './[id]/listing-editor';
import { LocationPicker } from './location-picker';
import type { Option, OptionGroup } from './taxonomy';
import { locationMatches, searchable } from './taxonomy-search';

vi.mock('./actions', () => ({
  confirmListingAction: vi.fn(),
  deleteTranslationAction: vi.fn(),
  saveFeaturesAction: vi.fn(),
  saveListingAction: vi.fn(),
  saveTranslationAction: vi.fn(),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const LISTING = {
  id: uuid(1),
  agencyId: uuid(2),
  ownerUserId: uuid(3),
  ref: 'ABCD2345',
  source: 'MANUAL',
  status: 'DRAFT',
  visibility: 'PRIVATE',
  shareScope: 'ALL',
  transactionType: 'SALE',
  price: { amountCents: 45_000_000, currency: 'EUR' },
  pricePeriod: null,
  priceOnRequest: false,
  priceToCents: null,
  communityFeeMonthCents: null,
  ibiYearCents: null,
  garbageTaxYearCents: null,
  commission: null,
  builtM2: null,
  plotM2: null,
  terraceM2: null,
  bedrooms: 3,
  bathrooms: 2,
  yearBuilt: null,
  energyRating: null,
  energyEmissionsRating: null,
  coordinates: null,
  locationPrecision: 'APPROX',
  propertyTypeId: uuid(4),
  locationId: uuid(10_000 + 4_321),
  private: {
    cadastralRef: null,
    internalNotes: null,
    keysInfo: null,
    coordinates: null,
    externalRef: null,
    lockedFields: [],
  },
  qualityScore: null,
  freshness: null,
  version: 1,
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  deletedAt: null,
} as unknown as ListingDto;

const LOCATIONS: Option[] = Array.from({ length: 5_000 }, (_, i) => ({
  id: uuid(10_000 + i),
  label: `Spain › Province ${i % 50} › Municipality ${i}`,
}));
/** 460 groups, 2,300 features: the shared test DB's shape and worse. */
const FEATURES: OptionGroup[] = Array.from({ length: 460 }, (_, g) => ({
  label: `Group ${g}`,
  options: Array.from({ length: 5 }, (_, f) => ({ id: uuid(100_000 + g * 5 + f), label: `Feature ${g}-${f}` })),
}));

/** Elements in the markup: what a browser would hold as DOM nodes (text nodes not counted, they are fewer). */
const elements = (html: string) => (html.match(/<[a-z][a-z0-9-]*[\s>/]/gi) ?? []).length;

describe('listing editor taxonomy at scale', () => {
  it('[S12-F23] the editor renders < 1,500 DOM nodes with 5,000 locations and 2,300 features', () => {
    const html = renderToStaticMarkup(
      <ListingEditor
        listing={LISTING}
        content={{ listingId: uuid(1), version: 1, translations: [], featureIds: [] } as ListingContentDto}
        propertyTypes={[]}
        locations={LOCATIONS}
        features={FEATURES}
        contentLocales={[{ code: 'es', label: 'Español' }]}
        mapStyleUrl="https://example.com/style.json"
        locale="en"
        messages={{}}
      />,
    );
    expect(elements(html)).toBeLessThan(1_500);
    // The current location is offered even though it is not among the first matches.
    expect(html).toContain('Municipality 4321');
  });

  it('[S12-F23] a search narrows the locations, accent-blind, and keeps the current choice', () => {
    const all = searchable([
      { id: 'a', label: 'España › Málaga › Marbella' },
      { id: 'b', label: 'España › Alicante › Dénia' },
    ]);
    expect(locationMatches(all, 'malaga marb', '').shown.map((o) => o.id)).toEqual(['a']);
    expect(locationMatches(all, 'denia', 'a').shown.map((o) => o.id)).toEqual(['a', 'b']);
    const html = renderToStaticMarkup(
      <LocationPicker
        options={LOCATIONS}
        value=""
        onChange={() => {}}
        placeholder
        selectClassName="x"
        labels={{ search: 'Search', showing: '{shown} of {total}', choose: 'Choose' }}
      />,
    );
    expect(elements(html)).toBeLessThan(80);
    expect(html).toContain('50 of 5000');
  });
});
