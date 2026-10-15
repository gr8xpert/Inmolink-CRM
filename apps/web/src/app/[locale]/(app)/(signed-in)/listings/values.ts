import type {
  CeeRating,
  ListingDto,
  ListingStatus,
  LocationPrecision,
  LockableListingField,
  PricePeriod,
  ShareScope,
  TransactionType,
  UpdateListingBody,
  Visibility,
} from '@inmolink/contracts';
import { parseHundredths } from '../settings/values';

/** The listing editor's field values (strings as typed), from the API's listing. */
export interface ListingValues {
  transactionType: TransactionType;
  propertyTypeId: string;
  locationId: string;
  price: string;
  currency: string;
  pricePeriod: PricePeriod | '';
  priceOnRequest: boolean;
  commissionType: 'PCT' | 'FIXED';
  commissionPercent: string;
  commissionAmount: string;
  commissionIncludesVat: boolean;
  splitPercent: string;
  builtM2: string;
  plotM2: string;
  terraceM2: string;
  bedrooms: string;
  bathrooms: string;
  yearBuilt: string;
  energyRating: CeeRating | '';
  energyEmissionsRating: CeeRating | '';
  lat: string;
  lng: string;
  locationPrecision: LocationPrecision;
  status: ListingStatus;
  visibility: Visibility;
  shareScope: ShareScope;
  cadastralRef: string;
  internalNotes: string;
  keysInfo: string;
  lockedFields: LockableListingField[];
}

const fromHundredths = (n: number) => String(n / 100);
const str = (v: number | null) => (v === null ? '' : String(v));

export function listingValues(l: ListingDto): ListingValues {
  const c = l.commission?.total ?? null;
  const exact = l.private?.coordinates ?? l.coordinates;
  return {
    transactionType: l.transactionType,
    propertyTypeId: l.propertyTypeId,
    locationId: l.locationId,
    price: l.price ? fromHundredths(l.price.amountCents) : '',
    currency: l.price?.currency ?? (c?.type === 'FIXED' ? c.amount.currency : 'EUR'),
    pricePeriod: l.pricePeriod ?? '',
    priceOnRequest: l.priceOnRequest,
    commissionType: c?.type ?? 'PCT',
    commissionPercent: c?.type === 'PCT' ? fromHundredths(c.basisPoints) : '',
    commissionAmount: c?.type === 'FIXED' ? fromHundredths(c.amount.amountCents) : '',
    commissionIncludesVat: c?.includesVat ?? false,
    splitPercent: l.commission?.splitBp == null ? '' : fromHundredths(l.commission.splitBp),
    builtM2: str(l.builtM2),
    plotM2: str(l.plotM2),
    terraceM2: str(l.terraceM2),
    bedrooms: str(l.bedrooms),
    bathrooms: str(l.bathrooms),
    yearBuilt: str(l.yearBuilt),
    energyRating: l.energyRating ?? '',
    energyEmissionsRating: l.energyEmissionsRating ?? '',
    lat: exact ? String(exact.lat) : '',
    lng: exact ? String(exact.lng) : '',
    locationPrecision: l.locationPrecision,
    status: l.status,
    visibility: l.visibility,
    shareScope: l.shareScope,
    cadastralRef: l.private?.cadastralRef ?? '',
    internalNotes: l.private?.internalNotes ?? '',
    keysInfo: l.private?.keysInfo ?? '',
    lockedFields: [...(l.private?.lockedFields ?? [])].sort(),
  };
}

/** A typed decimal ("120", "120,5", "36.7213") → number; '' → null; anything else → NaN (refused by the contract). */
export function parseDecimal(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  if (!/^-?\d{1,12}([.,]\d{1,8})?$/.test(s)) return Number.NaN;
  return Number(s.replace(',', '.'));
}

/** A typed whole number → number; '' → null; anything else → NaN. */
export function parseWhole(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  return /^\d{1,15}$/.test(s) ? Number(s) : Number.NaN;
}

/** An amount → cents with `parseHundredths` (no thousands separators); '' → null. */
const cents = (raw: string) => (raw.trim() === '' ? null : parseHundredths(raw));
const textOrNull = (raw: string) => (raw.trim() === '' ? null : raw.trim());

/**
 * Editor fields grouped by the body field they become, so a change to any of them sends that whole body field
 * (a commission is one object; coordinates are one pair).
 */
const GROUPS: ReadonlyArray<readonly [keyof UpdateListingBody, readonly (keyof ListingValues)[]]> = [
  ['transactionType', ['transactionType']],
  ['propertyTypeId', ['propertyTypeId']],
  ['locationId', ['locationId']],
  ['priceCents', ['price']],
  ['currency', ['currency']],
  ['pricePeriod', ['pricePeriod']],
  ['priceOnRequest', ['priceOnRequest']],
  ['commission', ['commissionType', 'commissionPercent', 'commissionAmount', 'commissionIncludesVat', 'currency']],
  ['splitBp', ['splitPercent']],
  ['builtM2', ['builtM2']],
  ['plotM2', ['plotM2']],
  ['terraceM2', ['terraceM2']],
  ['bedrooms', ['bedrooms']],
  ['bathrooms', ['bathrooms']],
  ['yearBuilt', ['yearBuilt']],
  ['energyRating', ['energyRating']],
  ['energyEmissionsRating', ['energyEmissionsRating']],
  ['coordinates', ['lat', 'lng']],
  ['locationPrecision', ['locationPrecision']],
  ['status', ['status']],
  ['visibility', ['visibility']],
  ['shareScope', ['shareScope']],
  ['cadastralRef', ['cadastralRef']],
  ['internalNotes', ['internalNotes']],
  ['keysInfo', ['keysInfo']],
  ['lockedFields', ['lockedFields']],
];

function bodyValue(field: keyof UpdateListingBody, v: ListingValues): unknown {
  switch (field) {
    case 'priceCents':
      return cents(v.price);
    case 'pricePeriod':
      return v.pricePeriod || null;
    case 'commission':
      return v.commissionType === 'PCT'
        ? { type: 'PCT', basisPoints: parseHundredths(v.commissionPercent), includesVat: v.commissionIncludesVat }
        : {
            type: 'FIXED',
            amount: { amountCents: parseHundredths(v.commissionAmount), currency: v.currency },
            includesVat: v.commissionIncludesVat,
          };
    case 'splitBp':
      return parseHundredths(v.splitPercent);
    case 'builtM2':
    case 'plotM2':
    case 'terraceM2':
      return parseDecimal(v[field]);
    case 'bedrooms':
    case 'bathrooms':
    case 'yearBuilt':
      return parseWhole(v[field]);
    case 'energyRating':
    case 'energyEmissionsRating':
      return v[field] || null;
    case 'coordinates': {
      const [lat, lng] = [parseDecimal(v.lat), parseDecimal(v.lng)];
      return lat === null && lng === null ? null : { lat: lat ?? Number.NaN, lng: lng ?? Number.NaN };
    }
    case 'cadastralRef':
    case 'internalNotes':
    case 'keysInfo':
      return textOrNull(v[field]);
    case 'lockedFields':
      return [...v.lockedFields].sort();
    default:
      return v[field as keyof ListingValues];
  }
}

/** Stands in for NaN in a JSON comparison (JSON.stringify turns NaN into null). */
const NAN_MARK = '<NaN>';

/** Equal as request values; NaN (a value the contract refuses) never equals anything, so it is always sent. */
const same = (a: unknown, b: unknown) => {
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'number' && Number.isNaN(x) ? NAN_MARK : x));
  const [ja, jb] = [json(a), json(b)];
  return ja === jb && !ja.includes(NAN_MARK);
};

/**
 * The PATCH body for what changed between the last saved values and the current ones (without `version`).
 * Empty when nothing changed. The caller validates it with `UpdateListingBody`.
 */
export function listingPatch(saved: ListingValues, current: ListingValues): Partial<UpdateListingBody> {
  const body: Record<string, unknown> = {};
  for (const [field, inputs] of GROUPS) {
    if (inputs.every((k) => saved[k] === current[k])) continue;
    const value = bodyValue(field, current);
    // "120,5" typed over a saved 120.5 is the same request value: nothing to send.
    if (same(bodyValue(field, saved), value)) continue;
    body[field] = value;
  }
  return body as Partial<UpdateListingBody>;
}

/** The editor field (input id) a body path or an API `details.field` points at. */
const FIELD_INPUTS: Record<string, keyof ListingValues> = {
  priceCents: 'price',
  price: 'price',
  commission: 'commissionPercent',
  'commission.basisPoints': 'commissionPercent',
  'commission.amount': 'commissionAmount',
  'commission.amount.amountCents': 'commissionAmount',
  'commission.amount.currency': 'currency',
  splitBp: 'splitPercent',
  split: 'splitPercent',
  coordinates: 'lat',
  'coordinates.lat': 'lat',
  'coordinates.lng': 'lng',
  propertyType: 'propertyTypeId',
  location: 'locationId',
};

export function inputOf(path: string): string {
  return FIELD_INPUTS[path] ?? path.split('.')[0] ?? path;
}

/** Lowercase, accent-free, dashes, ≤ 120 characters: the slug a title gives (as the API derives it). */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/, '');
  return slug || 'listing';
}

/** One locale's text in the editor. The slug follows the title until it is edited by hand. */
export interface TranslationDraft {
  title: string;
  description: string;
  slug: string;
  metaTitle: string;
  metaDescription: string;
  locked: boolean;
  slugEdited: boolean;
}

export function translationDraft(t: {
  title: string;
  description: string | null;
  slug: string;
  metaTitle: string | null;
  metaDescription: string | null;
  locked: boolean;
}): TranslationDraft {
  return {
    title: t.title,
    description: t.description ?? '',
    slug: t.slug,
    metaTitle: t.metaTitle ?? '',
    metaDescription: t.metaDescription ?? '',
    locked: t.locked,
    slugEdited: t.slug !== slugOf(t.title),
  };
}

export const EMPTY_TRANSLATION: TranslationDraft = {
  title: '',
  description: '',
  slug: '',
  metaTitle: '',
  metaDescription: '',
  locked: false,
  slugEdited: false,
};

/** The PUT body of a draft (without `version`); null while it has no title (nothing to save yet). */
export function translationBody(d: TranslationDraft) {
  const title = d.title.trim();
  if (title === '') return null;
  return {
    title,
    description: d.description === '' ? null : d.description,
    slug: d.slugEdited ? d.slug : slugOf(title),
    metaTitle: d.metaTitle.trim() || null,
    metaDescription: d.metaDescription.trim() || null,
    locked: d.locked,
  };
}

/** True when the draft differs from what is saved (as request values). */
export function translationChanged(saved: TranslationDraft | undefined, draft: TranslationDraft): boolean {
  const body = translationBody(draft);
  if (body === null) return false;
  return !saved || JSON.stringify(translationBody(saved)) !== JSON.stringify(body);
}
