/**
 * Network board (S11-05, PLAN §3 #24, §7 M11 — AMS): agencies post buyer requests, property offers, distressed sales and
 * developer announcements with structured criteria in the search vocabulary (transaction type, taxonomy ids, ranges)
 * and an expiry; members subscribe with filters; a reply opens a `NETWORK` chat thread with the post's agency; a buyer
 * request is matched against the other agencies' listings ("you have 3 listings matching this request").
 *
 * White label: a post carries only what its agency chose to publish — no author, no client, no commission — and its
 * text may not hold contact details (e-mail addresses, phone numbers): replies go through chat.
 */
import { z } from 'zod';
import { ChatMessageDto, ChatThreadDetailDto, SendChatMessageBody } from './chat';
import { PageQuery, pageOf } from './common';
import { TRANSACTION_TYPES } from './values';

export const NETWORK_POST_KINDS = ['BUYER_REQUEST', 'PROPERTY_OFFER', 'DISTRESSED', 'DEVELOPER_ANNOUNCEMENT'] as const;
export const NetworkPostKind = z.enum(NETWORK_POST_KINDS);
export type NetworkPostKind = z.infer<typeof NetworkPostKind>;

export const NetworkPostStatus = z.enum(['OPEN', 'CLOSED']);
export type NetworkPostStatus = z.infer<typeof NetworkPostStatus>;

/** A post's prices are in this currency: they are compared with the listings' euro prices of the search index. */
export const NETWORK_CURRENCY = 'EUR';

export const NETWORK_LIMITS = {
  titleChars: 120,
  bodyChars: 2_000,
  /** Days a post stays on the board at most, and by default. */
  maxExpiryDays: 90,
  defaultExpiryDays: 30,
  /** Taxonomy ids of one criterion (types, locations, features). */
  criteriaIds: 20,
  /** Subscriptions of one member. */
  subscriptionsPerUser: 20,
  subscriptionNameChars: 80,
  /** References a buyer request's match notification names per agency (the count covers the rest). */
  matchRefsPerAgency: 10,
} as const;

/** Control characters, line / paragraph separators and invisible format characters (bidi overrides) — joiners kept. */
const NO_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]|[^\P{Cf}\p{Join_Control}]/u;
/** The same for the post's text, which keeps its line breaks and tabs. */
const NO_CONTROL_TEXT = /[^\P{Cc}\n\r\t]|[\p{Zl}\p{Zp}]|[^\P{Cf}\p{Join_Control}]/u;
/** Contact details are refused in a post: the board is white-label, a reply goes through chat. */
const EMAIL_LIKE = /[^@\s]+@[^@\s]+\.[^@\s]+/;
const PHONE_LIKE = /\+?\d[ \d().-]{7,}\d/;
const noContact = (v: string) => !EMAIL_LIKE.test(v) && !PHONE_LIKE.test(v);

export const NetworkPostTitle = z
  .string()
  .trim()
  .min(1)
  .max(NETWORK_LIMITS.titleChars)
  .refine((v) => !NO_CONTROL.test(v), { message: 'no control characters' })
  .refine(noContact, { message: 'no contact details' });

export const NetworkPostText = z
  .string()
  .trim()
  .min(1)
  .max(NETWORK_LIMITS.bodyChars)
  .refine((v) => !NO_CONTROL_TEXT.test(v), { message: 'no control characters' })
  .refine(noContact, { message: 'no contact details' });

const Ids = z.array(z.uuid()).min(1).max(NETWORK_LIMITS.criteriaIds);
const Amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Rooms = z.number().int().min(0).max(50);
const Area = z.number().min(0).max(99_999_999);

/**
 * What a post is about, in the search vocabulary (S5-04): a transaction type, any of these property types, anywhere
 * under any of these locations, every one of these features, inclusive ranges. Prices in euro cents. Empty: anything.
 */
export const NetworkCriteria = z
  .strictObject({
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
export type NetworkCriteria = z.infer<typeof NetworkCriteria>;

/** `POST /v1/network/posts` (Idempotency-Key): a post of the caller's agency, on the board until it expires. */
export const CreateNetworkPostBody = z.strictObject({
  kind: NetworkPostKind,
  title: NetworkPostTitle,
  body: NetworkPostText,
  criteria: NetworkCriteria.default({}),
  expiresInDays: z.number().int().min(1).max(NETWORK_LIMITS.maxExpiryDays).default(NETWORK_LIMITS.defaultExpiryDays),
});
export type CreateNetworkPostBody = z.input<typeof CreateNetworkPostBody>;

export const NetworkPostDto = z.strictObject({
  id: z.uuid(),
  kind: NetworkPostKind,
  status: NetworkPostStatus,
  /** Past its expiry: off the board (other agencies no longer see it). */
  expired: z.boolean(),
  title: z.string(),
  body: z.string(),
  criteria: z.strictObject({
    transactionType: z.enum(TRANSACTION_TYPES).nullable(),
    propertyTypeIds: z.array(z.uuid()),
    locationIds: z.array(z.uuid()),
    featureIds: z.array(z.uuid()),
    priceMinCents: z.number().int().nullable(),
    priceMaxCents: z.number().int().nullable(),
    currency: z.string(),
    bedsMin: z.number().int().nullable(),
    bathsMin: z.number().int().nullable(),
    areaMinM2: z.number().nullable(),
    areaMaxM2: z.number().nullable(),
  }),
  /** The posting agency and its directory name (null when not listed). */
  agency: z.strictObject({ id: z.uuid(), name: z.string().nullable() }),
  /** The caller's agency posted it. */
  own: z.boolean(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type NetworkPostDto = z.infer<typeof NetworkPostDto>;
export const NetworkPostPage = pageOf(NetworkPostDto);
export type NetworkPostPage = z.infer<typeof NetworkPostPage>;

export const NetworkPostParams = z.object({ id: z.uuid() });

/** `GET /v1/network/posts`: the board, newest first — open, unexpired posts; `mine=true`: the agency's own, all states. */
export const ListNetworkPostsQuery = PageQuery.extend({
  kind: NetworkPostKind.optional(),
  mine: z.stringbool().optional(),
});
export type ListNetworkPostsQuery = z.infer<typeof ListNetworkPostsQuery>;
export type ListNetworkPostsInput = z.input<typeof ListNetworkPostsQuery>;

/** `POST /v1/network/posts/:id/replies`: the first (or next) message of the caller's agency's thread with the poster. */
export const ReplyNetworkPostBody = SendChatMessageBody;
export type ReplyNetworkPostBody = z.infer<typeof ReplyNetworkPostBody>;

export const NetworkReplyDto = z.strictObject({
  thread: ChatThreadDetailDto,
  message: ChatMessageDto,
  replayed: z.boolean(),
});
export type NetworkReplyDto = z.infer<typeof NetworkReplyDto>;

/**
 * A member's board subscription: other agencies' new posts that match every filter set notify the member
 * (`NETWORK_POST`). Kinds: any of them · transaction type: equal · types: any in common · locations: the post is about
 * one of them or a place under one · price: the ranges overlap (one open end of the post's range is open). Unset:
 * anything. Strict: a filter the post leaves empty does not match — a subscription to villas is not told of a post
 * naming no property type, one with a price band not of a post without prices.
 */
export const NetworkSubscriptionBody = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(NETWORK_LIMITS.subscriptionNameChars)
      .refine((v) => !NO_CONTROL.test(v), { message: 'no control characters' }),
    kinds: z.array(NetworkPostKind).min(1).max(NETWORK_POST_KINDS.length).optional(),
    transactionType: z.enum(TRANSACTION_TYPES).optional(),
    propertyTypeIds: Ids.optional(),
    locationIds: Ids.optional(),
    priceMinCents: Amount.optional(),
    priceMaxCents: Amount.optional(),
  })
  .refine((c) => c.priceMinCents === undefined || c.priceMaxCents === undefined || c.priceMinCents <= c.priceMaxCents, {
    message: 'priceMinCents must not exceed priceMaxCents',
    path: ['priceMinCents'],
  });
export type NetworkSubscriptionBody = z.infer<typeof NetworkSubscriptionBody>;

export const NetworkSubscriptionDto = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  kinds: z.array(NetworkPostKind),
  transactionType: z.enum(TRANSACTION_TYPES).nullable(),
  propertyTypeIds: z.array(z.uuid()),
  locationIds: z.array(z.uuid()),
  priceMinCents: z.number().int().nullable(),
  priceMaxCents: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type NetworkSubscriptionDto = z.infer<typeof NetworkSubscriptionDto>;

/** `GET /v1/network/subscriptions`: the caller's own (≤ `subscriptionsPerUser`, oldest first: no pages). */
export const NetworkSubscriptionList = z.strictObject({ items: z.array(NetworkSubscriptionDto) });
export type NetworkSubscriptionList = z.infer<typeof NetworkSubscriptionList>;

export const NetworkSubscriptionParams = z.object({ id: z.uuid() });
