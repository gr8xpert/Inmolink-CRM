/**
 * matching DTOs (PATTERNS §9). S5-06 (PLAN §7 M9): an agent's saved searches — network search's vocabulary, saved
 * with a name — and their alerts: a listing new on the market, its price dropped, or back on the market, sent as a
 * notification (`SAVED_SEARCH_ALERT`) at once or in a daily digest, and in the notifications' e-mail summary.
 */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';
import { ListingCardDoc } from './search';
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

/* ------------------------------------------------------------------ client profiles (R2-02a) */

/**
 * R2-02a (PLAN §7 M9, §3 #23): a client's search profile — what a buyer or tenant (a CRM contact of the agency) is
 * looking for, in the saved-search vocabulary, plus their wishes in their own words — and how the match engine works
 * it. Internal client data: never shown in Client Mode or to another agency.
 */
export const CLIENT_PROFILE_LIMITS = {
  /** Profiles of one contact (a buyer who also rents, a second home…). */
  perContact: 10,
  wishesChars: 2000,
  /** Taxonomy ids of one criterion (types, locations, features). */
  criteriaIds: 20,
} as const;

/** `OFF`: kept, never matched · `REVIEW`: matches wait for the agent · `AUTO_SEND`: matches are sent to the client. */
export const CLIENT_PROFILE_MODES = ['OFF', 'REVIEW', 'AUTO_SEND'] as const;
export const ClientProfileMode = z.enum(CLIENT_PROFILE_MODES);
export type ClientProfileMode = z.infer<typeof ClientProfileMode>;

export const CLIENT_PROFILE_FREQUENCIES = ['INSTANT', 'DAILY', 'WEEKLY'] as const;
export const ClientProfileFrequency = z.enum(CLIENT_PROFILE_FREQUENCIES);
export type ClientProfileFrequency = z.infer<typeof ClientProfileFrequency>;

/** Control characters other than tab and line breaks, separators and invisible format characters (bidi overrides). */
const NO_CONTROL_TEXT = /[^\P{Cc}\t\n\r]|[\p{Zl}\p{Zp}]|[^\P{Cf}\p{Join_Control}]/u;
const ProfileIds = z.array(z.uuid()).max(CLIENT_PROFILE_LIMITS.criteriaIds);

const clientProfileFields = {
  mode: ClientProfileMode.default('OFF'),
  frequency: ClientProfileFrequency.default('DAILY'),
  transactionType: z.enum(TRANSACTION_TYPES).nullish(),
  propertyTypeIds: ProfileIds.optional(),
  locationIds: ProfileIds.optional(),
  /** Must-haves. */
  featureIds: ProfileIds.optional(),
  priceMinCents: Amount.nullish(),
  priceMaxCents: Amount.nullish(),
  bedsMin: Rooms.nullish(),
  bathsMin: Rooms.nullish(),
  areaMinM2: Area.nullish(),
  areaMaxM2: Area.nullish(),
  /** The client's wishes in their words ("sea view, walk to the beach"); blank: none. */
  wishes: z
    .string()
    .trim()
    .max(CLIENT_PROFILE_LIMITS.wishesChars)
    .refine((v) => !NO_CONTROL_TEXT.test(v), { message: 'no control characters' })
    .nullish(),
};

type Ranges = {
  priceMinCents?: number | null | undefined;
  priceMaxCents?: number | null | undefined;
  areaMinM2?: number | null | undefined;
  areaMaxM2?: number | null | undefined;
};
const priceOrdered = (c: Ranges) =>
  c.priceMinCents == null || c.priceMaxCents == null || c.priceMinCents <= c.priceMaxCents;
const areaOrdered = (c: Ranges) => c.areaMinM2 == null || c.areaMaxM2 == null || c.areaMinM2 <= c.areaMaxM2;
const PRICE_ORDER = { message: 'priceMinCents must not exceed priceMaxCents', path: ['priceMinCents'] };
const AREA_ORDER = { message: 'areaMinM2 must not exceed areaMaxM2', path: ['areaMinM2'] };

/**
 * `POST /v1/crm/contacts/:id/profiles`: a new profile of the contact. A listing matches when it has the transaction
 * type, one of the property types, lies at or under one of the locations, has every must-have feature, and its price,
 * bedrooms, bathrooms and built area are within the bounds. Unset: anything.
 */
export const CreateClientProfileBody = z
  .strictObject(clientProfileFields)
  .refine(priceOrdered, PRICE_ORDER)
  .refine(areaOrdered, AREA_ORDER);
export type CreateClientProfileBody = z.input<typeof CreateClientProfileBody>;

/** `PUT /v1/client-profiles/:id`: every field replaced, at the profile's `version` (else `VERSION_CONFLICT`). */
export const UpdateClientProfileBody = z
  .strictObject({ version: z.number().int().min(1), ...clientProfileFields })
  .refine(priceOrdered, PRICE_ORDER)
  .refine(areaOrdered, AREA_ORDER);
export type UpdateClientProfileBody = z.input<typeof UpdateClientProfileBody>;

export const ClientProfileDto = z.strictObject({
  id: z.uuid(),
  contactId: z.uuid(),
  mode: ClientProfileMode,
  frequency: ClientProfileFrequency,
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
  wishes: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ClientProfileDto = z.infer<typeof ClientProfileDto>;

/** `GET /v1/crm/contacts/:id/profiles`: the contact's profiles, oldest first. */
export const ClientProfilePage = pageOf(ClientProfileDto);
export type ClientProfilePage = z.infer<typeof ClientProfilePage>;

export const ClientProfileParams = z.strictObject({ id: z.uuid() });
export type ClientProfileParams = z.infer<typeof ClientProfileParams>;

/* ------------------------------------------------------------------ R2-02d: the review queue */

/**
 * A match's status (R2-02b): `PENDING_REVIEW` waits for the agent (REVIEW profiles) · `QUEUED` waits for R2-02e's
 * delivery (AUTO_SEND) · `SENT` · `DISMISSED` (the agent turned it down: the learned boost counts a dislike) ·
 * `EXPIRED` (the listing can no longer be offered) · `APPROVED` (in a selection for the client; nothing sent).
 */
export const CLIENT_PROFILE_MATCH_STATUSES = [
  'PENDING_REVIEW',
  'QUEUED',
  'SENT',
  'DISMISSED',
  'EXPIRED',
  'APPROVED',
] as const;
export const ClientProfileMatchStatus = z.enum(CLIENT_PROFILE_MATCH_STATUSES);
export type ClientProfileMatchStatus = z.infer<typeof ClientProfileMatchStatus>;

/** The review queue lists these: pending (to approve or dismiss) or dismissed (to restore). */
export const REVIEW_QUEUE_STATUSES = ['PENDING_REVIEW', 'DISMISSED'] as const;

/**
 * `GET /v1/client-profile-matches`: the agency's queue, newest first (keyset, ≤ 100), or one contact's or one
 * profile's (not both).
 */
export const ListClientProfileMatchesQuery = PageQuery.extend({
  status: z.enum(REVIEW_QUEUE_STATUSES).default('PENDING_REVIEW'),
  contactId: z.uuid().optional(),
  profileId: z.uuid().optional(),
})
  .strict()
  .refine((q) => q.contactId === undefined || q.profileId === undefined, {
    message: 'give contactId or profileId, not both',
    path: ['profileId'],
  });
export type ListClientProfileMatchesQuery = z.input<typeof ListClientProfileMatchesQuery>;

/** A client profile's hard criteria, in the explanation's order (the match engine's `CriterionKey`). */
export const MATCH_CRITERION_KEYS = [
  'transaction',
  'propertyType',
  'location',
  'price',
  'bedrooms',
  'bathrooms',
  'area',
  'mustHaves',
] as const;

/** One line of a match's explanation in the reader's language: a criterion met or not, or the learned boost. */
export const MatchReason = z.strictObject({
  key: z.enum([...MATCH_CRITERION_KEYS, 'boost']),
  ok: z.boolean(),
  text: z.string(),
});
export type MatchReason = z.infer<typeof MatchReason>;

/**
 * A match in the review queue (member-facing): the listing's card from its read model (as network search shows it:
 * never the owner's details, commission or portal extras), the profile and contact it is for, the score and the
 * explanation in the caller's language. The listing's owner agency is never named here.
 */
export const ClientProfileMatchDto = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  contact: z.strictObject({ id: z.uuid(), firstName: z.string().nullable(), lastName: z.string().nullable() }),
  status: ClientProfileMatchStatus,
  /** 0–1. */
  score: z.number(),
  /** The listing is another agency's (network), not the caller's own. */
  network: z.boolean(),
  card: ListingCardDoc.omit({ portalText: true, portalTerraceM2: true }),
  explanation: z.strictObject({ summary: z.string(), reasons: z.array(MatchReason) }),
  /** Approved: the selection it was added to. */
  selectionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ClientProfileMatchDto = z.infer<typeof ClientProfileMatchDto>;

export const ClientProfileMatchPage = pageOf(ClientProfileMatchDto);
export type ClientProfileMatchPage = z.infer<typeof ClientProfileMatchPage>;

export const ClientProfileMatchParams = z.strictObject({ id: z.uuid() });
export type ClientProfileMatchParams = z.infer<typeof ClientProfileMatchParams>;

/** `POST /v1/client-profile-matches/:id/approve` · `/dismiss` · `/restore`: the match's status after the move. */
export const ClientProfileMatchMoveDto = z.strictObject({
  id: z.uuid(),
  status: ClientProfileMatchStatus,
  /** Approve: the selection (an open one of the contact reused, or a new one); nothing is sent. */
  selectionId: z.uuid().nullable(),
});
export type ClientProfileMatchMoveDto = z.infer<typeof ClientProfileMatchMoveDto>;
