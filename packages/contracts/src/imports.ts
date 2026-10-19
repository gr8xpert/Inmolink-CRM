/** imports DTOs (PATTERNS §9): feed connections, runs and per-item errors (S6-01). */
import { z } from 'zod';
import { CurrencyCode, PageQuery, pageOf } from './common';
import { MEDIA_PER_LISTING_MAX } from './media';
import { CeeRating, ContentLocaleCode, LocationPrecision, PricePeriod, TransactionType } from './properties';

/** Connector keys are code-registry names (`kyero`, `generic-xml`, …; S6-03+). */
export const FeedConnectorKey = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'a connector key such as kyero');
export type FeedConnectorKey = z.infer<typeof FeedConnectorKey>;

export const FeedRunState = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']);
export type FeedRunState = z.infer<typeof FeedRunState>;
export const FeedRunTrigger = z.enum(['SCHEDULE', 'MANUAL']);
export type FeedRunTrigger = z.infer<typeof FeedRunTrigger>;

/** Scheduled runs: every 15 minutes at most often, once a week at least often (null = manual only). */
export const FEED_SCHEDULE_MINUTES = { min: 15, max: 10_080 } as const;

/** http(s) feed URL; the SSRF checks (DNS, redirects) run when the feed is fetched. */
export const FeedUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine((v) => /^https?:\/\//i.test(v), 'an http or https URL');

/** Routing, framing and hop-by-hop headers (safe-fetch refuses them too): a credential header cannot be one. */
const RESERVED_CREDENTIAL_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'connection',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
  'expect',
  'accept-encoding',
  'user-agent',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

/**
 * Feed credentials, stored encrypted and never returned. `basic` sends HTTP Basic auth; `header` sends one
 * custom header (API keys); `query` adds one query parameter to the feed URL when it is fetched (feeds whose API
 * key lives in the URL: the key stays encrypted instead of sitting in the visible URL). A connector may read
 * other fields from its settings.
 */
export const FeedCredentials = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('basic'), username: z.string().min(1).max(200), password: z.string().min(1).max(500) })
    .strict(),
  z
    .object({
      type: z.literal('header'),
      name: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,64}$/)
        .refine((n) => !RESERVED_CREDENTIAL_HEADERS.has(n.toLowerCase()), 'this header cannot carry credentials'),
      value: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('query'),
      name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
      value: z.string().min(1).max(2_000),
    })
    .strict(),
]);
export type FeedCredentials = z.infer<typeof FeedCredentials>;

/** Connector options; each connector validates its own keys. Small (≤ 4 KB as JSON). */
export const FeedSettings = z
  .record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((v) => JSON.stringify(v).length <= 4_096, 'settings too large');
export type FeedSettings = z.infer<typeof FeedSettings>;

export const FeedConnectionDto = z.object({
  id: z.uuid(),
  name: z.string(),
  connector: FeedConnectorKey,
  url: z.string(),
  hasCredentials: z.boolean(),
  settings: FeedSettings,
  mappingProfileId: z.uuid().nullable(),
  enabled: z.boolean(),
  scheduleMinutes: z.number().int().nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  lastRunState: FeedRunState.nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type FeedConnectionDto = z.infer<typeof FeedConnectionDto>;
export const FeedConnectionPage = pageOf(FeedConnectionDto);
export type FeedConnectionPage = z.infer<typeof FeedConnectionPage>;

const ScheduleMinutes = z.number().int().min(FEED_SCHEDULE_MINUTES.min).max(FEED_SCHEDULE_MINUTES.max).nullable();

export const CreateFeedConnectionBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    connector: FeedConnectorKey,
    url: FeedUrl,
    credentials: FeedCredentials.nullable().optional(),
    settings: FeedSettings.optional(),
    mappingProfileId: z.uuid().nullable().optional(),
    enabled: z.boolean().optional(),
    scheduleMinutes: ScheduleMinutes.optional(),
  })
  .strict();
export type CreateFeedConnectionBody = z.infer<typeof CreateFeedConnectionBody>;

/** `credentials`: omitted keeps them, null removes them. */
export const UpdateFeedConnectionBody = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    url: FeedUrl.optional(),
    credentials: FeedCredentials.nullable().optional(),
    settings: FeedSettings.optional(),
    mappingProfileId: z.uuid().nullable().optional(),
    enabled: z.boolean().optional(),
    scheduleMinutes: ScheduleMinutes.optional(),
  })
  .strict();
export type UpdateFeedConnectionBody = z.infer<typeof UpdateFeedConnectionBody>;

export const FeedConnectionParams = z.object({ id: z.uuid() }).strict();
export const FeedRunParams = z.object({ runId: z.uuid() }).strict();
export const ListFeedConnectionsQuery = PageQuery.extend({}).strict();
export type ListFeedConnectionsQuery = z.infer<typeof ListFeedConnectionsQuery>;
export const ListFeedRunsQuery = PageQuery.extend({}).strict();
export type ListFeedRunsQuery = z.infer<typeof ListFeedRunsQuery>;
export const ListFeedItemErrorsQuery = PageQuery.extend({}).strict();
export type ListFeedItemErrorsQuery = z.infer<typeof ListFeedItemErrorsQuery>;

export const FeedRunDto = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  trigger: FeedRunTrigger,
  state: FeedRunState,
  attempt: z.number().int(),
  counts: z.object({
    total: z.number().int(),
    valid: z.number().int(),
    failed: z.number().int(),
    created: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
    /** Listings of this run held as DRAFT for an unmatched location, type or feature (S6-02). */
    held: z.number().int(),
    /** Listings this run withdrew: missing from the feed for the connection's number of runs (S6-02). */
    withdrawn: z.number().int(),
  }),
  /** Per-item errors kept for this run (the first `FEED_ERRORS_KEPT`; `counts.failed` counts all). */
  errorsLogged: z.number().int(),
  bytesRead: z.number().int(),
  /** Why the whole run failed (`FEED_*` code), or null. */
  errorCode: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type FeedRunDto = z.infer<typeof FeedRunDto>;
export const FeedRunPage = pageOf(FeedRunDto);
export type FeedRunPage = z.infer<typeof FeedRunPage>;

export const FeedItemErrorDto = z.object({
  id: z.uuid(),
  position: z.number().int(),
  itemRef: z.string().nullable(),
  code: z.string(),
  field: z.string().nullable(),
  message: z.string().nullable(),
});
export type FeedItemErrorDto = z.infer<typeof FeedItemErrorDto>;
export const FeedItemErrorPage = pageOf(FeedItemErrorDto);
export type FeedItemErrorPage = z.infer<typeof FeedItemErrorPage>;

/** Per-item errors kept per run; later failures only count. */
export const FEED_ERRORS_KEPT = 1_000;

/** Codes a whole run can fail with (`FeedRunDto.errorCode`), for the run history UI. */
export const FEED_RUN_ERROR_CODES = [
  'FEED_DESTINATION_BLOCKED',
  'FEED_FETCH_FAILED',
  'FEED_HTTP_STATUS',
  'FEED_TIMEOUT',
  'FEED_TOO_LARGE',
  'FEED_CONTENT_TYPE',
  'FEED_DTD_NOT_ALLOWED',
  'FEED_MALFORMED',
  'FEED_CONNECTOR_UNKNOWN',
  'FEED_CONNECTION_DISABLED',
  'FEED_LEASE_EXPIRED',
  'FEED_NEVER_STARTED',
  'FEED_NO_OWNER',
  'INTERNAL',
] as const;
export type FeedRunErrorCode = (typeof FEED_RUN_ERROR_CODES)[number];

/** Statuses a feed may give a listing; WITHDRAWN comes from missing runs, DRAFT from holds (S6-02). */
export const FEED_LISTING_STATUSES = ['ACTIVE', 'UNDER_OFFER', 'SOLD', 'RENTED'] as const;

/** `numeric(10,2)`: below 100,000,000 m². */
const FeedArea = z.number().min(0).max(99_999_999.99);
const FeedCount = z.number().int().min(0).max(1000);
/** No NUL or other control characters (Postgres text refuses NUL; a bad item fails alone, not its batch). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const FeedText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !CONTROL.test(v), 'control characters are not allowed');
/** A taxonomy value as the feed writes it (resolved by the S2-05 resolver; longer text is never a name). */
const FeedTaxonText = FeedText(200)
  .transform((v) => v.trim())
  .pipe(z.string().min(1));
/** Image URLs are fetched later by the media worker through `safeFetch` (S6-02); http(s) only. */
const FeedImageUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), 'an http or https URL');

/**
 * One listing as a connector maps it (S6-02 loader input; S6-03+ connectors produce it). Taxonomy values are the
 * feed's text, resolved by the loader per location level with the parent as hint; an unmatched value holds the
 * listing as DRAFT until staff map it. Prices in cents; images in feed order.
 */
export const FeedListing = z
  .object({
    /** The listing's id in the feed (unique per feed; the re-import key). */
    ref: FeedText(200)
      .transform((v) => v.trim())
      .pipe(z.string().min(1)),
    transactionType: TransactionType,
    status: z.enum(FEED_LISTING_STATUSES).default('ACTIVE'),
    priceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
    currency: CurrencyCode.default('EUR'),
    pricePeriod: PricePeriod.nullable().default(null),
    priceOnRequest: z.boolean().default(false),
    builtM2: FeedArea.nullable().default(null),
    plotM2: FeedArea.nullable().default(null),
    terraceM2: FeedArea.nullable().default(null),
    bedrooms: FeedCount.nullable().default(null),
    bathrooms: FeedCount.nullable().default(null),
    yearBuilt: z.number().int().min(1000).max(3000).nullable().default(null),
    energyRating: CeeRating.nullable().default(null),
    energyEmissionsRating: CeeRating.nullable().default(null),
    coordinates: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .strict()
      .nullable()
      .default(null),
    locationPrecision: LocationPrecision.default('APPROX'),
    propertyType: FeedTaxonText,
    /** From the country down; at least one level. Each level is resolved under the one above it. */
    location: z
      .object({
        country: FeedTaxonText.optional(),
        region: FeedTaxonText.optional(),
        city: FeedTaxonText.optional(),
        area: FeedTaxonText.optional(),
      })
      .strict()
      .refine((l) => Object.values(l).some(Boolean), 'at least one location level'),
    features: z.array(FeedTaxonText).max(200).default([]),
    translations: z
      .array(
        z
          .object({
            locale: ContentLocaleCode,
            title: FeedText(200)
              .transform((v) => v.trim())
              .pipe(z.string().min(1)),
            description: FeedText(20_000).nullable().default(null),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    images: z.array(FeedImageUrl).max(MEDIA_PER_LISTING_MAX).default([]),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.transactionType === 'SALE' && l.pricePeriod !== null) {
      ctx.addIssue({ code: 'custom', path: ['pricePeriod'], message: 'a sale has no price period' });
    }
    if (l.status === 'SOLD' && l.transactionType !== 'SALE') {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'SOLD is for sales' });
    }
    if (l.status === 'RENTED' && l.transactionType === 'SALE') {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'RENTED is for rentals' });
    }
    if (new Set(l.translations.map((t) => t.locale)).size !== l.translations.length) {
      ctx.addIssue({ code: 'custom', path: ['translations'], message: 'one translation per locale' });
    }
  });
export type FeedListing = z.infer<typeof FeedListing>;
export type FeedListingInput = z.input<typeof FeedListing>;

/** Connection settings the loader reads (S6-02); connectors read their own keys from the same record. */
export const FeedLoaderSettings = z.object({
  /** The member new imported listings belong to; default: the agency's first active admin. */
  ownerUserId: z.uuid().optional(),
  /** Runs a listing may be missing from the feed before it is WITHDRAWN; default from `IMPORT_WITHDRAW_AFTER_MISSED_RUNS`. */
  withdrawAfterMissedRuns: z.number().int().min(1).max(100).optional(),
});
export type FeedLoaderSettings = z.infer<typeof FeedLoaderSettings>;
