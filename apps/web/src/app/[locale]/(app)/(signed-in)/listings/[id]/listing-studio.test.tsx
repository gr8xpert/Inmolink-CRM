import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ListingContentDto, ListingDto } from '@inmolink/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ListingEditor } from './listing-editor';

vi.mock('../actions', () => ({
  confirmListingAction: vi.fn(),
  deleteTranslationAction: vi.fn(),
  requestStudioAction: vi.fn(),
  saveFeaturesAction: vi.fn(),
  saveListingAction: vi.fn(),
  saveTranslationAction: vi.fn(),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

/** The listing editor's AI Listing Studio panel (S12-02): EN + ES strings, tone presets, the draft review. */

const require = createRequire(import.meta.url);
/** The `listings` catalog (the page passes `messages.listings`, i.e. this file). */
const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(require.resolve(`@inmolink/i18n/messages/${locale}/listings.json`), 'utf8'));

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const listing = (over: Partial<ListingDto> = {}) =>
  ({
    id: uuid(1),
    agencyId: uuid(2),
    ownerUserId: uuid(3),
    ref: 'ABCD2345',
    status: 'DRAFT',
    visibility: 'PRIVATE',
    shareScope: 'ALL',
    transactionType: 'SALE',
    price: null,
    commission: null,
    bedrooms: 3,
    bathrooms: 2,
    coordinates: null,
    locationPrecision: 'APPROX',
    propertyTypeId: uuid(4),
    locationId: uuid(5),
    private: { cadastralRef: null, internalNotes: null, keysInfo: null, coordinates: null, lockedFields: [] },
    freshness: null,
    version: 2,
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
    deletedAt: null,
    ...over,
  }) as unknown as ListingDto;

const content = {
  listingId: uuid(1),
  version: 2,
  featureIds: [],
  translations: [
    {
      locale: 'en',
      title: 'Villa in Calpe',
      description: 'A villa with 3 bedrooms.',
      slug: 'villa-in-calpe',
      metaTitle: null,
      metaDescription: null,
      origin: 'AI_DRAFT',
      locked: false,
      updatedAt: '2026-10-15T10:00:00.000Z',
    },
  ],
} as ListingContentDto;

const render = (locale: string, l: ListingDto = listing()) =>
  renderToStaticMarkup(
    <ListingEditor
      listing={l}
      content={content}
      propertyTypes={[]}
      locations={[]}
      features={[]}
      contentLocales={[
        { code: 'en', label: 'English' },
        { code: 'es', label: 'Español' },
      ]}
      mapStyleUrl="https://example.com/style.json"
      locale={locale}
      messages={catalog(locale)}
    />,
  );

describe('listing editor: AI Listing Studio (S12-02)', () => {
  it('[S12-02] the studio panel offers the tone presets and marks an AI draft for review (EN)', () => {
    const html = render('en');
    expect(html).toContain('data-testid="listing-studio"');
    expect(html).toContain('Write with AI');
    for (const tone of ['Professional', 'Warm', 'Luxury', 'Concise', 'Investor']) expect(html).toContain(tone);
    expect(html).toContain('This text is an AI draft');
    expect(html).toContain('Mark as reviewed');
  });

  it('[S12-02] the panel is translated (ES)', () => {
    const html = render('es');
    expect(html).toContain('Redactar con IA');
    expect(html).toContain('Marcar como revisado');
    expect(html).toContain('Cercano');
  });

  it('[S12-02] a listing the caller cannot edit has no studio and no review button', () => {
    const html = render('en', listing({ private: null } as Partial<ListingDto>));
    expect(html).not.toContain('data-testid="listing-studio"');
    expect(html).not.toContain('Mark as reviewed');
  });
});
