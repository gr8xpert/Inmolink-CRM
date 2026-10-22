/** imports DTOs (PATTERNS §9): feed connections, runs and per-item errors (S6-01). */
import { z } from 'zod';
import { CurrencyCode, PageQuery, pageOf } from './common';
import { MEDIA_PER_LISTING_MAX } from './media';
import { CeeRating, ContentLocaleCode, LocationPrecision, PricePeriod, TransactionType } from './properties';
import { StaffReason } from './staff';
import { MAPPER_SAMPLE, SHEET_MAPPED_CONNECTOR, XML_MAPPED_CONNECTOR } from './values';

export { SHEET_MAPPED_CONNECTOR, XML_MAPPED_CONNECTOR };

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

/**
 * Resales Online connection settings (S6-F4), checked when a connection is created or changed. `filterAlias`: the
 * Filter Alias of the agency's Resales portal (1 Sale, 2 Short Term Rent, 3 Long Term Rent, 4 Featured), never the
 * numeric Filter Id. `languages`: a comma list of content locales to fetch besides English ("" = English only).
 */
export const ResalesFeedSettings = z
  .object({
    filterAlias: z.enum(['1', '2', '3', '4']).optional(),
    languages: z
      .string()
      .max(200)
      .regex(/^\s*([a-z]{2}\s*(,\s*[a-z]{2}\s*)*)?$/)
      .optional(),
  })
  .loose();
export type ResalesFeedSettings = z.infer<typeof ResalesFeedSettings>;

/** The only host a Resales Online connection talks to (S7-F14: the form fixes it, the service refuses any other). */
export const RESALES_API_HOST = 'webapi.resales-online.com';
export const RESALES_API_URL = `https://${RESALES_API_HOST}/V6`;
/** The API key's maximum length: the credentials contract's password limit. */
export const RESALES_API_KEY_MAX = 500;

/**
 * The Resales Online connection form's fields as the connection body wants them (S7-F14), shared by the dashboard
 * form and the tests. The filter alias is sent as typed: the service refuses a bad one with `FEED_SETTINGS_INVALID`.
 * On edit both credential fields blank keep the saved credentials; only one filled is `CREDENTIALS_INCOMPLETE`.
 */
export function resalesConnectionInput(
  fields: { clientId: string; apiKey: string; filterAlias: string; languages: string },
  editing: boolean,
):
  | {
      ok: true;
      url: string;
      credentials: FeedCredentials | undefined;
      settings: { filterAlias: string; languages: string };
    }
  | { ok: false; error: 'CREDENTIALS_INCOMPLETE' } {
  const clientId = fields.clientId.trim();
  const apiKey = fields.apiKey.trim();
  if (editing && (clientId === '') !== (apiKey === '')) return { ok: false, error: 'CREDENTIALS_INCOMPLETE' };
  return {
    ok: true,
    url: RESALES_API_URL,
    credentials: editing && apiKey === '' ? undefined : { type: 'basic', username: clientId, password: apiKey },
    settings: {
      filterAlias: fields.filterAlias.trim(),
      languages: fields.languages
        .split(',')
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean)
        .join(','),
    },
  };
}

/** Connector options; each connector validates its own keys. Small (≤ 4 KB as JSON). */
export const FeedSettings = z
  .record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((v) => JSON.stringify(v).length <= 4_096, 'settings too large');
export type FeedSettings = z.infer<typeof FeedSettings>;

/**
 * Why the anomaly guard paused a connection (S6-08). `EMPTY_FEED` (S7-F1): a run read no valid item — the feed was
 * empty or every item failed — while the connection still had live listings; nothing was withdrawn.
 */
export const FeedPauseReason = z.enum(['VOLUME_SPIKE', 'MASS_WITHDRAWAL', 'EMPTY_FEED']);
export type FeedPauseReason = z.infer<typeof FeedPauseReason>;

/**
 * What the guard saw. VOLUME_SPIKE: `items` read when the run stopped vs the feed's `typical` item count (median of
 * its last successful runs) and the factor. MASS_WITHDRAWAL: `missing` of the feed's `live` listings vanished at once
 * vs the ratio. EMPTY_FEED: `items` read (all invalid, or 0) while the connection had `live` listings. Counts only —
 * never feed content.
 */
export const FeedPauseDetails = z.object({
  items: z.number().int().optional(),
  typical: z.number().int().optional(),
  factor: z.number().optional(),
  missing: z.number().int().optional(),
  live: z.number().int().optional(),
  ratio: z.number().optional(),
});
export type FeedPauseDetails = z.infer<typeof FeedPauseDetails>;

export const FeedPauseDto = z.object({
  at: z.iso.datetime(),
  reason: FeedPauseReason,
  details: FeedPauseDetails,
  runId: z.uuid().nullable(),
});
export type FeedPauseDto = z.infer<typeof FeedPauseDto>;

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
  /** Paused by the anomaly guard (S6-08): not scheduled, "run now" refused, until resumed. */
  pause: FeedPauseDto.nullable(),
  /** Resumed with "accept the change": the next run skips the anomaly guard once. */
  acceptAnomalyOnce: z.boolean(),
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

/**
 * `POST /v1/imports/connections/:id/resume` (S6-08). `acceptChange`: the drop or spike is real (the agency sold off a
 * portfolio, merged feeds): the next run proceeds without the guard. Otherwise the next run is checked again.
 */
export const ResumeFeedConnectionBody = z.object({ acceptChange: z.boolean() }).strict();
export type ResumeFeedConnectionBody = z.infer<typeof ResumeFeedConnectionBody>;

/**
 * `POST /v1/staff/imports/connections/:id/resume` (S7-F1): staff also say why (`StaffReason`, the support ticket or
 * what they checked with the agency). Stored on the connection for staff, never in the audit log (free text).
 */
export const StaffResumeFeedConnectionBody = z.object({ acceptChange: z.boolean(), reason: StaffReason }).strict();
export type StaffResumeFeedConnectionBody = z.infer<typeof StaffResumeFeedConnectionBody>;

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
  /**
   * S7-F12: the feed API's own words for that failure (e.g. Resales Online's "FilterAgencyId not valid"), credentials
   * removed, at most 500 characters; null when the source said nothing.
   */
  errorDetail: z.string().nullable(),
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
  'FEED_MAPPING_INVALID',
  'FEED_CONNECTION_DISABLED',
  'FEED_LEASE_EXPIRED',
  'FEED_NEVER_STARTED',
  'FEED_NO_OWNER',
  /** S6-08 anomaly guard: the run stopped (spike) or withdrew nothing (drop); the connection is paused. */
  'FEED_PAUSED_VOLUME_SPIKE',
  'FEED_PAUSED_MASS_WITHDRAWAL',
  /** S7-F1: nothing valid while the connection has live listings; nothing withdrawn, the connection is paused. */
  'FEED_PAUSED_EMPTY_FEED',
  'FEED_CONNECTION_PAUSED',
  /** S6-F4: the feed's API refused the credentials (Resales: "P1 or P2 not valid" after the busy retries), or none were given. */
  'FEED_CREDENTIALS_REJECTED',
  /** S6-F4: a connector setting is not valid (e.g. a Resales filter alias other than 1-4). */
  'FEED_SETTINGS_INVALID',
  'INTERNAL',
] as const;
export type FeedRunErrorCode = (typeof FEED_RUN_ERROR_CODES)[number];

/** Statuses a feed may give a listing; WITHDRAWN comes from missing runs, DRAFT from holds (S6-02). */
export const FEED_LISTING_STATUSES = ['ACTIVE', 'UNDER_OFFER', 'SOLD', 'RENTED'] as const;

/** `numeric(10,2)`: below 100,000,000 m². */
const FeedArea = z.number().min(0).max(99_999_999.99);
const FeedCount = z.number().int().min(0).max(1000);
const FeedCents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
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

/** A new development a feed lists with its units (S7-F14). Created once per reference; commission is never part of it. */
export const FeedDevelopment = z
  .object({
    name: FeedTaxonText,
    keyReady: z.boolean().nullable().default(null),
    units: z
      .array(
        z
          .object({
            ref: FeedText(40)
              .transform((v) => v.trim())
              .pipe(z.string().min(1)),
            /** The unit type as the feed writes it (resolved like a listing's property type). */
            type: FeedTaxonText.nullable().default(null),
            priceCents: FeedCents.nullable().default(null),
            builtM2: FeedArea.nullable().default(null),
            terraceM2: FeedArea.nullable().default(null),
            bedrooms: FeedCount.nullable().default(null),
            bathrooms: FeedCount.nullable().default(null),
            status: z.enum(['AVAILABLE', 'RESERVED', 'SOLD']).default('AVAILABLE'),
          })
          .strict(),
      )
      .max(500)
      .refine((us) => new Set(us.map((u) => u.ref)).size === us.length, 'one line per unit reference'),
  })
  .strict();
export type FeedDevelopment = z.infer<typeof FeedDevelopment>;

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
    /** The end of a price range ("from" is `priceCents`); null for a single price (S7-F14). */
    priceToCents: FeedCents.nullable().default(null),
    /** Running costs: the community fee per month, IBI and the refuse tax per year (S7-F14). */
    communityFeeMonthCents: FeedCents.nullable().default(null),
    ibiYearCents: FeedCents.nullable().default(null),
    garbageTaxYearCents: FeedCents.nullable().default(null),
    /** The new development this listing belongs to, with its units, when the feed has one (S7-F14). */
    development: FeedDevelopment.nullable().default(null),
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

// ── Generic XML connector and visual mapper (S6-04) ────────────────────────────────────────────────────────────

const NAME = '[A-Za-z_][A-Za-z0-9_.:-]{0,63}';
/**
 * A path from the record element down: element names separated by `/`, the last one may be an attribute (`@id`);
 * `@id` alone is an attribute of the record element itself. No wildcards, no indexes: every element with that
 * path is read (a repeated element gives several values).
 */
const PATH_RE = new RegExp(`^(?:@${NAME}|${NAME}(?:/${NAME}){0,7}(?:/@${NAME})?)$`);
export const XmlPath = z.string().trim().max(300).regex(PATH_RE, 'a path such as price, location/lat or @id');
export type XmlPath = z.infer<typeof XmlPath>;
const ElementName = z.string().regex(new RegExp(`^${NAME}$`), 'an element name');

const ValueMap = z
  .record(z.string().min(1).max(120), z.string().max(200))
  .refine((v) => Object.keys(v).length <= 100, 'at most 100 value translations');

/** Where one value comes from: a path in the record, or a constant; `map` translates the feed's words (case-insensitive). */
export const MappedValue = z
  .object({
    path: XmlPath.optional(),
    constant: z.string().trim().min(1).max(200).optional(),
    map: ValueMap.optional(),
  })
  .strict()
  .refine((v) => (v.path === undefined) !== (v.constant === undefined), 'give either a path or a constant');
export type MappedValue = z.infer<typeof MappedValue>;

const ListSource = z.object({ path: XmlPath, separator: z.string().min(1).max(3).optional() }).strict();

/** A mapping profile of the `xml-mapped` connector: paths relative to the record element. */
export const XmlMapping = z
  .object({
    schemaVersion: z.literal(1),
    /** The repeating element, as written in the document (`property`, `g:item`). */
    recordElement: ElementName,
    /** `point`: 1250.50; `comma`: 1.250,50 (the point groups thousands). */
    decimalSeparator: z.enum(['point', 'comma']).default('point'),
    /** `ref` and `propertyType` are required; the rest is optional. */
    fields: z
      .object({
        ref: MappedValue,
        propertyType: MappedValue,
        transactionType: MappedValue.optional(),
        status: MappedValue.optional(),
        price: MappedValue.optional(),
        currency: MappedValue.optional(),
        pricePeriod: MappedValue.optional(),
        builtM2: MappedValue.optional(),
        plotM2: MappedValue.optional(),
        terraceM2: MappedValue.optional(),
        bedrooms: MappedValue.optional(),
        bathrooms: MappedValue.optional(),
        yearBuilt: MappedValue.optional(),
        energyRating: MappedValue.optional(),
        energyEmissionsRating: MappedValue.optional(),
        latitude: MappedValue.optional(),
        longitude: MappedValue.optional(),
        country: MappedValue.optional(),
        region: MappedValue.optional(),
        city: MappedValue.optional(),
        area: MappedValue.optional(),
      })
      .strict(),
    features: z.array(ListSource).max(10).default([]),
    images: z.array(ListSource).max(10).default([]),
    translations: z
      .array(
        z
          .object({ locale: ContentLocaleCode, title: MappedValue.optional(), description: MappedValue.optional() })
          .strict(),
      )
      .max(30)
      .default([]),
  })
  .strict()
  .refine((m) => JSON.stringify(m).length <= 32_768, 'mapping too large');
export type XmlMapping = z.infer<typeof XmlMapping>;
export type XmlMappingInput = z.input<typeof XmlMapping>;

/** One record of the sample as the parser read it (names, attributes, text, children): what the mapper previews. */
export interface XmlRecordNode {
  name: string;
  attributes: Record<string, string>;
  text: string;
  children: XmlRecordNode[];
}
const RECORD_LIMITS = { depth: 12, nodes: 4_000 } as const;
/**
 * One schema per level (not a lazy recursive one): a body nested deeper than `RECORD_LIMITS.depth` fails at the
 * leaf level (no children allowed) instead of recursing until the stack is gone.
 */
function recordSchema(levels: number): z.ZodType<XmlRecordNode> {
  const node = (children: z.ZodType<XmlRecordNode[]>) =>
    z
      .object({
        name: z.string().max(64),
        attributes: z.record(z.string().max(64), z.string().max(2_000)),
        text: z.string().max(20_000),
        children,
      })
      .strict();
  let schema: z.ZodType<XmlRecordNode> = node(z.array(z.never()).max(0) as unknown as z.ZodType<XmlRecordNode[]>);
  for (let i = 0; i < levels; i++) schema = node(z.array(schema).max(RECORD_LIMITS.nodes));
  return schema;
}
export const XmlRecord = recordSchema(RECORD_LIMITS.depth);
const nodeCount = (n: XmlRecordNode, depth = 0): number =>
  depth > RECORD_LIMITS.depth
    ? Number.POSITIVE_INFINITY
    : 1 + n.children.reduce((a, c) => a + nodeCount(c, depth + 1), 0);
const SampleRecords = z
  .array(XmlRecord)
  .min(1)
  .max(MAPPER_SAMPLE.maxRecords)
  .refine((r) => r.every((n) => nodeCount(n) <= RECORD_LIMITS.nodes), 'a record is too large')
  .refine((r) => JSON.stringify(r).length <= 1_000_000, 'sample too large');

/** A path of the sample with how many records carry it and a few values (clipped). */
export const MapperPathDto = z.object({
  path: z.string(),
  /** Records (of the sample) in which the path has a value. */
  count: z.number().int(),
  /** The path repeats inside one record (a list: images, features). */
  repeated: z.boolean(),
  samples: z.array(z.string()),
});
export type MapperPathDto = z.infer<typeof MapperPathDto>;

export const MapperSampleDto = z.object({
  /** The repeating element chosen (detected, or the one asked for). */
  recordElement: z.string(),
  /** Repeating elements that could be the record, best first. */
  candidates: z.array(z.object({ name: z.string(), count: z.number().int() })),
  /** Records read into the sample (at most `MAPPER_SAMPLE.maxRecords`). */
  recordCount: z.number().int(),
  /** The body was cut at the sample size. */
  truncated: z.boolean(),
  bytes: z.number().int(),
  paths: z.array(MapperPathDto),
  /**
   * A first guess per field (`ref` → `@code`) from the names in the sample: the mapper starts from it. Keys are the
   * mapping's fields, `features` and `images`, and `title` and `description` for its first translation (S7-F2).
   */
  suggested: z.record(z.string(), z.string()),
  records: z.array(XmlRecord),
  /** Set when the sample is a CSV or Excel file (S6-05): the file is stored and the import reads it by this id. */
  sheet: z.object({ fileId: z.uuid(), kind: z.enum(['csv', 'xlsx']) }).optional(),
});
export type MapperSampleDto = z.infer<typeof MapperSampleDto>;

/** A sample from a URL (fetched through `safeFetch`, bounded). */
export const MapperSampleUrlBody = z
  .object({ url: FeedUrl, credentials: FeedCredentials.nullable().optional(), recordElement: ElementName.optional() })
  .strict();
export type MapperSampleUrlBody = z.infer<typeof MapperSampleUrlBody>;
/** A raw upload's query: re-detect with this record element. */
export const MapperSampleUploadQuery = z.object({ recordElement: ElementName.optional() }).strict();
export type MapperSampleUploadQuery = z.infer<typeof MapperSampleUploadQuery>;

export const MapperPreviewBody = z.object({ mapping: XmlMapping, records: SampleRecords }).strict();
export type MapperPreviewBody = z.infer<typeof MapperPreviewBody>;

const MapperProblem = z.object({ code: z.string(), field: z.string().nullable(), message: z.string().nullable() });
export type MapperProblem = z.infer<typeof MapperProblem>;
export const MapperPreviewDto = z.object({
  items: z.array(
    z.object({
      position: z.number().int(),
      ref: z.string().nullable(),
      /** The listing as it would be imported (null when refused). */
      listing: z.record(z.string(), z.unknown()).nullable(),
      problems: z.array(MapperProblem),
    }),
  ),
});
export type MapperPreviewDto = z.infer<typeof MapperPreviewDto>;

/** `connectionId`: compare with the listings that connection imported (created vs updated); without it all are new. */
export const MapperDryRunBody = z
  .object({ mapping: XmlMapping, records: SampleRecords, connectionId: z.uuid().optional() })
  .strict();
export type MapperDryRunBody = z.infer<typeof MapperDryRunBody>;

export const MAPPER_REPORT_ROWS = 50;
export const MapperDryRunDto = z.object({
  total: z.number().int(),
  /** Records that map to a valid listing. */
  valid: z.number().int(),
  wouldCreate: z.number().int(),
  wouldUpdate: z.number().int(),
  /** Of the valid ones: held as DRAFT because a location, type or feature has no match yet. */
  wouldHold: z.number().int(),
  refused: z.number().int(),
  /** The first `MAPPER_REPORT_ROWS` refusals. */
  refusals: z.array(z.object({ position: z.number().int(), itemRef: z.string().nullable(), problem: MapperProblem })),
  /** Taxonomy values without a match, with the number of records carrying them. */
  unmatched: z.array(
    z.object({ kind: z.enum(['location', 'propertyType', 'feature']), text: z.string(), count: z.number().int() }),
  ),
  /** True when created/updated were compared with a connection's listings. */
  comparedWithConnection: z.boolean(),
});
export type MapperDryRunDto = z.infer<typeof MapperDryRunDto>;

export const MappingProfileDto = z.object({
  id: z.uuid(),
  name: z.string(),
  connector: FeedConnectorKey,
  mapping: XmlMapping,
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MappingProfileDto = z.infer<typeof MappingProfileDto>;
/** The list shows names, not mappings (a mapping is up to 32 KB): open one to read its mapping. */
export const MappingProfileSummaryDto = MappingProfileDto.omit({ mapping: true });
export type MappingProfileSummaryDto = z.infer<typeof MappingProfileSummaryDto>;
export const MappingProfilePage = pageOf(MappingProfileSummaryDto);
export type MappingProfilePage = z.infer<typeof MappingProfilePage>;

export const CreateMappingProfileBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    mapping: XmlMapping,
    /** The connector the profile is for: a feed (default) or an uploaded CSV / Excel file (S6-05). */
    connector: z.enum([XML_MAPPED_CONNECTOR, SHEET_MAPPED_CONNECTOR]).optional(),
  })
  .strict();
export type CreateMappingProfileBody = z.infer<typeof CreateMappingProfileBody>;
export const UpdateMappingProfileBody = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    mapping: XmlMapping.optional(),
  })
  .strict();
export type UpdateMappingProfileBody = z.infer<typeof UpdateMappingProfileBody>;
export const MappingProfileParams = z.object({ id: z.uuid() }).strict();
export const ListMappingProfilesQuery = PageQuery.extend({
  connector: z.enum([XML_MAPPED_CONNECTOR, SHEET_MAPPED_CONNECTOR]).optional(),
}).strict();
export type ListMappingProfilesQuery = z.infer<typeof ListMappingProfilesQuery>;

// ── CSV / Excel files (S6-05) ──────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /v1/imports/sheets/import`: start importing an uploaded file with this mapping. Without `connectionId` a new
 * connection (and its mapping profile) is created for the file; with one, that connection gets the new file and the
 * new mapping — the listings its earlier files created are updated, not duplicated.
 */
export const StartSheetImportBody = z
  .object({
    fileId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    mapping: XmlMapping,
    connectionId: z.uuid().optional(),
  })
  .strict();
export type StartSheetImportBody = z.infer<typeof StartSheetImportBody>;

export const StartSheetImportDto = z.object({ connectionId: z.uuid(), run: FeedRunDto });
export type StartSheetImportDto = z.infer<typeof StartSheetImportDto>;

// ── Staff import health (S6-08) ──────────────────────────────────────────────────────────────────────────────

/** The staff dashboard's window: runs finished in the last 24 hours. */
export const IMPORT_HEALTH_WINDOW_HOURS = 24;
/** Rows of each list on the dashboard. */
export const IMPORT_HEALTH_LIST_LIMIT = 50;

export const ImportHealthDto = z.object({
  windowHours: z.number().int(),
  runs: z.object({
    finished: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    /** Runs the anomaly guard stopped (among `failed`). */
    paused: z.number().int(),
  }),
  /** Failed runs of the window by error code, most frequent first. */
  failures: z.array(z.object({ code: z.string(), count: z.number().int() })),
  lag: z.object({
    queued: z.number().int(),
    running: z.number().int(),
    /** Seconds the oldest queued run has waited (0 when none). */
    oldestQueuedSeconds: z.number().int(),
    /** Queue wait (start − queued) of runs that finished in the window. */
    p95WaitSeconds: z.number().int(),
    maxWaitSeconds: z.number().int(),
  }),
  paused: z.array(
    z.object({
      connectionId: z.uuid(),
      agencyId: z.uuid(),
      name: z.string(),
      connector: z.string(),
      pause: FeedPauseDto,
    }),
  ),
  recentFailures: z.array(
    z.object({
      runId: z.uuid(),
      connectionId: z.uuid(),
      agencyId: z.uuid(),
      connector: z.string(),
      errorCode: z.string(),
      finishedAt: z.iso.datetime(),
    }),
  ),
  /** Open feed values waiting for a staff mapping (S2-05 queue), by kind. */
  unmatched: z.object({ location: z.number().int(), propertyType: z.number().int(), feature: z.number().int() }),
});
export type ImportHealthDto = z.infer<typeof ImportHealthDto>;

/** Staff roles that may resume a paused feed (S6-08): it lets a feed write or withdraw an agency's listings again. */
export const IMPORT_RESUME_STAFF_ROLES = ['SUPER_ADMIN', 'STAFF_DATA_OPS'] as const;

/** What a staff resume answers: staff never read a connection's URL, credentials or settings (column grants). */
export const StaffResumeFeedConnectionDto = z.object({
  id: z.uuid(),
  pause: FeedPauseDto.nullable(),
  acceptAnomalyOnce: z.boolean(),
  nextRunAt: z.iso.datetime().nullable(),
});
export type StaffResumeFeedConnectionDto = z.infer<typeof StaffResumeFeedConnectionDto>;
