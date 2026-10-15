import { type ListingDto, UpdateListingBody } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TRANSLATION,
  inputOf,
  listingPatch,
  listingValues,
  slugOf,
  translationBody,
  translationChanged,
  translationDraft,
} from './values';

const LISTING: ListingDto = {
  id: '01900000-0000-7000-8000-000000000001',
  agencyId: '01900000-0000-7000-8000-000000000002',
  ownerUserId: '01900000-0000-7000-8000-000000000003',
  ref: 'ABCD2345',
  source: 'MANUAL',
  status: 'DRAFT',
  visibility: 'PRIVATE',
  shareScope: 'ALL',
  transactionType: 'SALE',
  price: { amountCents: 45_000_000, currency: 'EUR' },
  pricePeriod: null,
  priceOnRequest: false,
  commission: { total: { type: 'PCT', basisPoints: 500, includesVat: false }, splitBp: 5000 },
  builtM2: 120.5,
  plotM2: null,
  terraceM2: null,
  bedrooms: 3,
  bathrooms: 2,
  yearBuilt: null,
  energyRating: null,
  energyEmissionsRating: null,
  coordinates: { lat: 36.51, lng: -4.88 },
  locationPrecision: 'APPROX',
  propertyTypeId: '01900000-0000-7000-8000-000000000004',
  locationId: '01900000-0000-7000-8000-000000000005',
  private: {
    cadastralRef: null,
    internalNotes: null,
    keysInfo: null,
    coordinates: { lat: 36.5101, lng: -4.8823 },
    externalRef: null,
    lockedFields: ['price'],
  },
  qualityScore: null,
  freshness: null,
  version: 3,
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  deletedAt: null,
};

describe('listing editor values', () => {
  it('[S3-05] autosave sends only the changed fields, as the contract expects them', () => {
    const saved = listingValues(LISTING);
    expect(saved).toMatchObject({ price: '450000', commissionPercent: '5', splitPercent: '50', lat: '36.5101' });
    expect(listingPatch(saved, saved)).toEqual({});
    const patch = listingPatch(saved, {
      ...saved,
      price: '455000,50',
      visibility: 'SHARED',
      status: 'ACTIVE',
      lockedFields: ['price', 'coordinates'],
    });
    expect(patch).toEqual({
      priceCents: 45_500_050,
      visibility: 'SHARED',
      status: 'ACTIVE',
      lockedFields: ['coordinates', 'price'],
    });
    expect(UpdateListingBody.safeParse({ ...patch, version: 3 }).success).toBe(true);
  });

  it('[S3-05] the same value typed differently is not sent again; a cleared field is sent as null', () => {
    const saved = listingValues(LISTING);
    expect(listingPatch(saved, { ...saved, builtM2: '120,50' })).toEqual({});
    expect(listingPatch(saved, { ...saved, bedrooms: '' })).toEqual({ bedrooms: null });
    expect(listingPatch(saved, { ...saved, lat: '', lng: '' })).toEqual({ coordinates: null });
    expect(listingPatch(saved, { ...saved, commissionPercent: '3,5' })).toEqual({
      commission: { type: 'PCT', basisPoints: 350, includesVat: false },
    });
  });

  it('[S3-05] a value the contract refuses is still sent, so the field is marked invalid', () => {
    const saved = listingValues(LISTING);
    const patch = listingPatch(saved, { ...saved, bedrooms: 'three', price: '5.000,00' });
    const parsed = UpdateListingBody.safeParse({ ...patch, version: 3 });
    expect(parsed.success).toBe(false);
    const paths = parsed.error?.issues.map((i) => inputOf(i.path.join('.'))).sort();
    expect(paths).toEqual(['bedrooms', 'price']);
    expect(inputOf('commission.amount.amountCents')).toBe('commissionAmount');
  });

  it('[S3-05] translations: the slug follows the title until edited; a draft without a title is not saved', () => {
    expect(slugOf('Villa con vistas al mar — Marbella')).toBe('villa-con-vistas-al-mar-marbella');
    expect(slugOf('¿?')).toBe('listing');
    expect(translationBody({ ...EMPTY_TRANSLATION, description: 'x' })).toBeNull();
    expect(translationChanged(undefined, { ...EMPTY_TRANSLATION, description: 'x' })).toBe(false);
    const saved = translationDraft({
      title: 'Ático en Málaga',
      description: null,
      slug: 'atico-en-malaga',
      metaTitle: null,
      metaDescription: null,
      locked: false,
    });
    expect(saved.slugEdited).toBe(false);
    expect(translationChanged(saved, { ...saved, title: 'Ático en Málaga ' })).toBe(false);
    expect(translationBody({ ...saved, title: 'Ático luminoso' })?.slug).toBe('atico-luminoso');
    expect(translationBody({ ...saved, slug: 'mi-atico', slugEdited: true, title: 'Otro' })?.slug).toBe('mi-atico');
    expect(translationChanged(saved, { ...saved, locked: true })).toBe(true);
  });
});
