/**
 * matching DTOs (PATTERNS §9). S5-06 (PLAN §7 M9): an agent's saved searches — network search's vocabulary, saved
 * with a name — and their alerts: a listing new on the market, its price dropped, or back on the market, sent as a
 * notification (`SAVED_SEARCH_ALERT`) at once or in a daily digest, and in the notifications' e-mail summary.
 */
import { z } from 'zod';
import { TRANSACTION_TYPES } from './values';

export const SAVED_SEARCH_LIMITS = {
  /** Saved searches of one member. */
  perUser: 50,
  nameChars: 80,
  /** Taxonomy ids of one criterion (types, locations, features). */
  criteriaIds: 20,
  /** Listing references one alert notification names (its count covers the rest). */
  refsPerNotification: 10,
} as const;

export const SAVED_SEARCH_ALERT_KINDS = ['NEW', 'PRICE_DROP', 'BACK_ON_MARKET'] as const;
export const SavedSearchAlertKind = z.enum(SAVED_SEARCH_ALERT_KINDS);
export type SavedSearchAlertKind = z.infer<typeof SavedSearchAlertKind>;

/** `OWN`: the agency's own listings · `NETWORK`: other agencies' listings shared with it · `ALL`: both. */
export const SAVED_SEARCH_SCOPES = ['ALL', 'OWN', 'NETWORK'] as const;
export const SavedSearchScope = z.enum(SAVED_SEARCH_SCOPES);
export type SavedSearchScope = z.infer<typeof SavedSearchScope>;

/** `INSTANT`: one notification per matching listing · `DAILY`: one digest a day · `OFF`: saved, no alerts. */
export const SAVED_SEARCH_FREQUENCIES = ['INSTANT', 'DAILY', 'OFF'] as const;
export const SavedSearchFrequency = z.enum(SAVED_SEARCH_FREQUENCIES);
export type SavedSearchFrequency = z.infer<typeof SavedSearchFrequency>;

/** Control characters, line / paragraph separators and invisible format characters (bidi overrides) — joiners kept. */
const NO_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]|[^\P{Cf}\p{Join_Control}]/u;
const Ids = z.array(z.uuid()).min(1).max(SAVED_SEARCH_LIMITS.criteriaIds);
const Amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Rooms = z.number().int().min(0).max(50);
const Area = z.number().min(0).max(99_999_999);

/**
 * A saved search: an ACTIVE listing matches when it has the transaction type, one of the property types, lies at or
 * under one of the locations, has every feature, and its price (a price on request matches no price bound), bedrooms,
 * bathrooms and built area are within the bounds. Unset: anything. `alerts`: the kinds that alert (default all).
 */
export const SavedSearchBody = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(SAVED_SEARCH_LIMITS.nameChars)
      .refine((v) => !NO_CONTROL.test(v), { message: 'no control characters' }),
    scope: SavedSearchScope.default('ALL'),
    frequency: SavedSearchFrequency.default('INSTANT'),
    alerts: z
      .array(SavedSearchAlertKind)
      .min(1)
      .max(SAVED_SEARCH_ALERT_KINDS.length)
      .default([...SAVED_SEARCH_ALERT_KINDS]),
    transactionType: z.enum(TRANSACTION_TYPES).optional(),
    propertyTypeIds: Ids.optional(),
    locationIds: Ids.optional(),
    featureIds: Ids.optional(),
    priceMinCents: Amount.optional(),
    priceMaxCents: Amount.optional(),
    bedsMin: Rooms.optional(),
    bathsMin: Rooms.optional(),
    areaMinM2: Area.optional(),
    areaMaxM2: Area.optional(),
  })
  .refine((c) => c.priceMinCents === undefined || c.priceMaxCents === undefined || c.priceMinCents <= c.priceMaxCents, {
    message: 'priceMinCents must not exceed priceMaxCents',
    path: ['priceMinCents'],
  })
  .refine((c) => c.areaMinM2 === undefined || c.areaMaxM2 === undefined || c.areaMinM2 <= c.areaMaxM2, {
    message: 'areaMinM2 must not exceed areaMaxM2',
    path: ['areaMinM2'],
  });
export type SavedSearchBody = z.input<typeof SavedSearchBody>;

export const SavedSearchDto = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  scope: SavedSearchScope,
  frequency: SavedSearchFrequency,
  alerts: z.array(SavedSearchAlertKind),
  transactionType: z.enum(TRANSACTION_TYPES).nullable(),
  propertyTypeIds: z.array(z.uuid()),
  locationIds: z.array(z.uuid()),
  featureIds: z.array(z.uuid()),
  priceMinCents: z.number().int().nullable(),
  priceMaxCents: z.number().int().nullable(),
  bedsMin: z.number().int().nullable(),
  bathsMin: z.number().int().nullable(),
  areaMinM2: z.number().nullable(),
  areaMaxM2: z.number().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SavedSearchDto = z.infer<typeof SavedSearchDto>;

/** `GET /v1/saved-searches`: the caller's own (≤ `perUser`, oldest first: no pages). */
export const SavedSearchList = z.strictObject({ items: z.array(SavedSearchDto) });
export type SavedSearchList = z.infer<typeof SavedSearchList>;

export const SavedSearchParams = z.object({ id: z.uuid() });
