/**
 * Shared pieces of the push adapters (S9-04): the portal-neutral facts of a listing, taken only from the client-safe
 * `WebsiteDetail` (never an owner, commission or private note: the type has none), and the PUT / DELETE calls both
 * partner APIs are assumed to share.
 */
import type { FeedItem } from '../../../feed-xml';
import { type PortalHttp, PortalPushError } from './types';

export interface CommonFacts {
  ref: string;
  operation: 'sale' | 'rent';
  type: string;
  /** Whole euros. */
  priceEuros: number;
  country: string | null;
  region: string | null;
  town: string | null;
  geo: { latitude: number; longitude: number } | null;
  bedrooms: number | null;
  bathrooms: number | null;
  builtM2: number | null;
  plotM2: number | null;
  energy: string | null;
  features: string[];
  language: string;
  description: string;
}

/**
 * What a portal may place on its map. An EXACT pin is rounded to 3 decimals (about 110 m) whatever the portal offers for
 * hiding it - until H6 confirms a portal-side setting, the exact point never leaves; an APPROX one is sent as the read
 * model has it.
 */
function blurred(geo: { lat: number; lng: number; precision: string }): { latitude: number; longitude: number } {
  if (geo.precision !== 'EXACT') return { latitude: geo.lat, longitude: geo.lng };
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { latitude: round(geo.lat), longitude: round(geo.lng) };
}

/** The facts of a listing in `locale` (its own text in that language when it has one, else the base text). */
export function mapCommon(item: FeedItem, locale: string): CommonFacts {
  const d = item.base;
  const text = item.texts.get(locale) ?? d;
  const listing = d.kind === 'LISTING' ? d : null;
  const unit = d.kind === 'UNIT' ? d : null;
  return {
    ref: d.ref,
    operation: listing && listing.transactionType !== 'SALE' ? 'rent' : 'sale',
    type: d.propertyType.name,
    priceEuros: d.price.amountCents === null ? 0 : Math.round(d.price.amountCents / 100),
    country: d.place.country?.name ?? null,
    region: d.place.region?.name ?? null,
    town: d.place.city?.name ?? d.place.area?.name ?? null,
    geo: d.geo ? blurred(d.geo) : null,
    bedrooms: d.bedrooms,
    bathrooms: d.bathrooms,
    builtM2: listing ? listing.builtM2 : (unit?.internalM2 ?? null),
    plotM2: d.plotM2,
    energy: listing?.energyRating ?? null,
    features: listing ? listing.features.map((f) => f.name) : [],
    language: locale,
    description: (text.description ?? '').trim(),
  };
}

/** Ids and references that go into a URL path or are stored: nothing else is accepted. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,200}$/;

const safeKey = (key: string): string => {
  if (!SAFE_KEY.test(key)) throw new PortalPushError('INVALID_REF', false, 'LISTING');
  return key;
};

/** The portal's id for the advert if it looks like one, else our own key. */
const idOf = (json: unknown, fallback: string): string => {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === 'string' && SAFE_KEY.test(id) ? id : fallback;
};

/** `PUT {base}/{key}`: create or replace. The advert's key is our reference; a portal-assigned `id` wins. */
export async function putAdvert(
  http: PortalHttp,
  base: string,
  key: string,
  payload: unknown,
  opts: { creating: boolean },
): Promise<{ remoteId: string }> {
  try {
    const res = await http.request('PUT', `${base}/${encodeURIComponent(safeKey(key))}`, payload);
    return { remoteId: idOf(res.json, key) };
  } catch (err) {
    // Creating an advert cannot meet "not found": the path is wrong, which retrying does not mend.
    if (opts.creating && err instanceof PortalPushError && err.code === 'NOT_FOUND') {
      throw new PortalPushError('NOT_CONFIGURED', false, 'CONNECTION');
    }
    throw err;
  }
}

/** `DELETE {base}/{key}`: an advert the portal no longer has counts as withdrawn. */
export async function removeAdvert(http: PortalHttp, base: string, key: string): Promise<void> {
  try {
    await http.request('DELETE', `${base}/${encodeURIComponent(safeKey(key))}`);
  } catch (err) {
    if (err instanceof PortalPushError && err.code === 'NOT_FOUND') return;
    throw err;
  }
}
