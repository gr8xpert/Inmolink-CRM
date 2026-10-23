/**
 * idealista adapter (S9-04) — the partner "Import API", ASSUMED. idealista's developer documentation is behind the
 * partner login (searched 2026-10-23: only the OAuth2 client-credentials token flow is described publicly, by
 * integrators), so everything below is the shape a partner API of this kind has and must be checked against the
 * specification H6 delivers:
 *
 * - Auth: OAuth2 client credentials (Basic `clientId:clientSecret` to the token URL, bearer afterwards).
 * - Identity: the advert is keyed by our listing reference (`propertyCode`), so `PUT /v1/properties/{code}` creates or
 *   replaces it (idempotent: a retry after a lost answer cannot duplicate it) and `DELETE` takes it down.
 * - Payload: JSON; prices in whole euros; the exact pin is never sent (`showAddress: false`, the read model's
 *   coordinates are approximate for non-exact precision).
 * Sandbox vs production: the base URL only (`configurePortalPush`). Mapping is pure and covered by the fake server
 * tests; nothing here has run against idealista.
 */
import { feedPictureUrls } from '../../../feed-xml';
import { PORTAL_PREFERRED_LOCALE, type PortalProfile } from '../profiles';
import { mapCommon, putAdvert, removeAdvert } from './map';
import type { PortalAdapter } from './types';

export const IDEALISTA_PROFILE: PortalProfile = {
  code: 'idealista',
  format: 'generic-v1',
  confirmed: false,
  schema: 'idealista/partner-api.json',
  minPhotos: 3,
  maxPhotos: 50,
  minDescriptionChars: 30,
  maxDescriptionChars: 4_000,
  energyRating: 'required',
  priceOnRequest: 'refused',
};

export const idealistaAdapter: PortalAdapter = {
  code: 'idealista',
  credentials: { fields: ['clientId', 'clientSecret'], required: ['clientId', 'clientSecret'] },
  profile: IDEALISTA_PROFILE,
  mapListing(item, locale) {
    const c = mapCommon(item, locale || PORTAL_PREFERRED_LOCALE);
    return {
      propertyCode: c.ref,
      operation: c.operation,
      type: c.type,
      price: c.priceEuros,
      address: { country: c.country, province: c.region, town: c.town, showAddress: false },
      location: c.geo,
      features: {
        areaConstructed: c.builtM2,
        areaPlot: c.plotM2,
        rooms: c.bedrooms,
        bathroomNumber: c.bathrooms,
        energyCertificateRating: c.energy,
        extras: c.features,
      },
      descriptions: [{ language: c.language, text: c.description }],
      images: feedPictureUrls(item.base)
        .slice(0, IDEALISTA_PROFILE.maxPhotos ?? undefined)
        .map((url, i) => ({ url, label: i === 0 ? 'cover' : null, order: i + 1 })),
    };
  },
  publish: (http, ref, payload) => putAdvert(http, '/v1/properties', ref, payload, { creating: true }),
  update: (http, remoteId, payload) => putAdvert(http, '/v1/properties', remoteId, payload, { creating: false }),
  withdraw: (http, remoteId) => removeAdvert(http, '/v1/properties', remoteId),
};
