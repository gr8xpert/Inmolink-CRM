/**
 * Fotocasa adapter (S9-04) — Adevinta's partner API, ASSUMED. Nothing is published about Fotocasa's (or Adevinta
 * Spain's) listing integration beyond "agents and software partners are onboarded by Fotocasa Pro / partner support"
 * (searched 2026-10-23: no developer portal, no specification). The shape below is the same pattern as idealista's —
 * OAuth2 client credentials, adverts keyed by the partner's own reference, JSON, `PUT` to create or replace and
 * `DELETE` to take down — with Fotocasa-style field names, and must be replaced by the specification H6 delivers.
 * Sandbox vs production is the base URL only. Nothing here has run against Fotocasa.
 */
import { feedPictureUrls } from '../../../feed-xml';
import { PORTAL_PREFERRED_LOCALE, type PortalProfile } from '../profiles';
import { mapCommon, putAdvert, removeAdvert } from './map';
import type { PortalAdapter } from './types';

export const FOTOCASA_PROFILE: PortalProfile = {
  code: 'fotocasa',
  format: 'generic-v1',
  confirmed: false,
  schema: 'fotocasa/partner-api.json',
  minPhotos: 3,
  maxPhotos: 40,
  minDescriptionChars: 30,
  maxDescriptionChars: 5_000,
  energyRating: 'required',
  priceOnRequest: 'refused',
};

export const fotocasaAdapter: PortalAdapter = {
  code: 'fotocasa',
  credentials: { fields: ['clientId', 'clientSecret'], required: ['clientId', 'clientSecret'] },
  profile: FOTOCASA_PROFILE,
  mapListing(item, locale) {
    const c = mapCommon(item, locale || PORTAL_PREFERRED_LOCALE);
    return {
      externalId: c.ref,
      transaction: c.operation === 'sale' ? 'SALE' : 'RENT',
      propertyType: c.type,
      price: { amount: c.priceEuros, currency: 'EUR' },
      location: {
        country: c.country,
        province: c.region,
        municipality: c.town,
        hideExactAddress: true,
        latitude: c.geo?.latitude ?? null,
        longitude: c.geo?.longitude ?? null,
      },
      surface: { built: c.builtM2, plot: c.plotM2 },
      rooms: c.bedrooms,
      bathrooms: c.bathrooms,
      energyRating: c.energy,
      amenities: c.features,
      description: { language: c.language, text: c.description },
      photos: feedPictureUrls(item.base)
        .slice(0, FOTOCASA_PROFILE.maxPhotos ?? undefined)
        .map((url, i) => ({ url, position: i + 1 })),
    };
  },
  publish: (http, ref, payload) => putAdvert(http, '/v2/ads', ref, payload, { creating: true }),
  update: (http, remoteId, payload) => putAdvert(http, '/v2/ads', remoteId, payload, { creating: false }),
  withdraw: (http, remoteId) => removeAdvert(http, '/v2/ads', remoteId),
};
