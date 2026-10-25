/**
 * Website sites (S7-01, PLAN §6 Website delivery, §9.1): an agency's websites, the listings each one shows
 * (inventory policy) and how it presents them (reference prefix, locales, contact overrides).
 */
import { z } from 'zod';
import { Cursor, pageOf } from './common';
import { DevelopmentStatus } from './developments';
import { ListingMediaKind, ListingRoomType, VideoProvider } from './media';
import { TransactionType } from './properties';
import {
  ListingCardDoc,
  ListingDetailDoc,
  PUBLIC_SEARCH_FACETS,
  PUBLIC_SEARCH_STATUSES,
  PublicSearchFacet,
  PublicSearchSort,
  PublicSearchStatus,
  READ_MODEL_IMAGE_SIZES,
  ReadModelGeo,
  ReadModelPlace,
  UnitCardDoc,
  UnitDetailDoc,
} from './search';

/**
 * How a site runs. IFRAME (S7-F8): search, results and detail pages served by Inmolink (`/embed/<site>/…` on the
 * public pages host) for the site's own domains to frame — only a site in this mode is served there, and only inside
 * its domains (`frame-ancestors`).
 */
export const WebsiteMode = z.enum(['WP_PLUGIN', 'WIDGET', 'HOSTED', 'IFRAME']);
export type WebsiteMode = z.infer<typeof WebsiteMode>;

/**
 * Which listings a site shows. OWN_ONLY: the agency's own PUBLIC listings and units. OWN_PLUS_NETWORK: also other
 * agencies' PUBLIC listings shared with it (shared with everyone, or by an owner that prefers it). CUSTOM: either
 * or both, narrowed by `SiteInventoryFilters`.
 */
export const InventoryPolicy = z.enum(['OWN_ONLY', 'OWN_PLUS_NETWORK', 'CUSTOM']);
export type InventoryPolicy = z.infer<typeof InventoryPolicy>;

const uuidSet = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate id' })
    .default([]);

export const MAX_SITE_FILTER_IDS = 50;
const MAX_PRICE_CENTS = 100_000_000_000;

/**
 * A CUSTOM policy's filters: whose listings (own, network or both), anywhere under any of `locationIds` (empty:
 * anywhere), any of `propertyTypeIds` (empty: any), an inclusive price band, new-build units on or off, and a
 * minimum commission on network listings (never on the site's own).
 */
export const SiteInventoryFilters = z
  .object({
    includeOwn: z.boolean().default(true),
    includeNetwork: z.boolean().default(false),
    locationIds: uuidSet(MAX_SITE_FILTER_IDS),
    propertyTypeIds: uuidSet(MAX_SITE_FILTER_IDS),
    priceMinCents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
    priceMaxCents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
    newBuilds: z.boolean().default(true),
    /** Network listings only (S7-F4): at least this total commission, in basis points of the price (1 = 0.01 %). */
    minCommissionBp: z.number().int().min(1).max(10_000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.includeOwn && !v.includeNetwork) {
      ctx.addIssue({ code: 'custom', path: ['includeOwn'], message: 'a site shows own or network listings' });
    }
    if (v.priceMinCents !== undefined && v.priceMaxCents !== undefined && v.priceMinCents > v.priceMaxCents) {
      ctx.addIssue({ code: 'custom', path: ['priceMaxCents'], message: 'price band is empty' });
    }
    if (v.minCommissionBp !== undefined && !v.includeNetwork) {
      ctx.addIssue({
        code: 'custom',
        path: ['minCommissionBp'],
        message: 'a minimum commission needs network listings',
      });
    }
  });
export type SiteInventoryFilters = z.infer<typeof SiteInventoryFilters>;

/** Contact details a site shows instead of the agency's (each one optional; at least one). */
export const SiteContact = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.email().max(254).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,24}$/)
      .optional(),
    whatsapp: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,24}$/)
      .optional(),
  })
  .strict()
  .refine((c) => Object.values(c).some((v) => v !== undefined), { message: 'empty contact' });
export type SiteContact = z.infer<typeof SiteContact>;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** A host name the site runs on: lower case, no scheme, port or path (`www.example.com`). */
export const SiteDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(new RegExp(`^${LABEL}(?:\\.${LABEL})+$`));

export const MAX_SITE_DOMAINS = 10;
export const MAX_SITE_LOCALES = 20;

/** A content locale code (`en`, `es`, …); the service checks it against `CONTENT_LOCALES`. */
const SiteLocale = z.string().regex(/^[a-z]{2}$/);

const siteFields = {
  name: z.string().trim().min(1).max(80),
  domains: z
    .array(SiteDomain)
    .max(MAX_SITE_DOMAINS)
    .refine((d) => new Set(d).size === d.length, { message: 'duplicate domain' })
    .default([]),
  mode: WebsiteMode,
  inventoryPolicy: InventoryPolicy.default('OWN_ONLY'),
  /** Required with CUSTOM, refused otherwise. */
  inventoryFilters: SiteInventoryFilters.nullable().default(null),
  /** Upper-case letters and digits, 1–6 (`ABC` → `ABC-1234`); null: network references as they are. */
  referencePrefix: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{1,6}$/)
    .nullable()
    .default(null),
  /** The default locale first. */
  locales: z
    .array(SiteLocale)
    .min(1)
    .max(MAX_SITE_LOCALES)
    .refine((l) => new Set(l).size === l.length, { message: 'duplicate locale' }),
  contact: SiteContact.nullable().default(null),
};

function policyFilters(
  v: { inventoryPolicy?: InventoryPolicy; inventoryFilters?: SiteInventoryFilters | null },
  ctx: z.RefinementCtx,
) {
  if (v.inventoryPolicy === undefined) return;
  if (v.inventoryPolicy === 'CUSTOM' && !v.inventoryFilters) {
    ctx.addIssue({ code: 'custom', path: ['inventoryFilters'], message: 'a CUSTOM policy needs filters' });
  }
  if (v.inventoryPolicy !== 'CUSTOM' && v.inventoryFilters) {
    ctx.addIssue({ code: 'custom', path: ['inventoryFilters'], message: 'filters are for a CUSTOM policy' });
  }
}

/** `POST /v1/sites` (agency admins). */
export const CreateSiteBody = z.object(siteFields).strict().superRefine(policyFilters);
export type CreateSiteInput = z.infer<typeof CreateSiteBody>;

/**
 * `PATCH /v1/sites/:siteId` (agency admins): the fields sent replace the stored ones. The policy and its filters
 * change together (both or neither).
 */
export const UpdateSiteBody = z
  .object({
    /** The version the edit was made on (`SiteDto.version`): a newer stored one → 409 VERSION_CONFLICT. */
    version: z.number().int().min(1),
    name: siteFields.name.optional(),
    domains: siteFields.domains.optional(),
    mode: WebsiteMode.optional(),
    inventoryPolicy: InventoryPolicy.optional(),
    inventoryFilters: SiteInventoryFilters.nullable().optional(),
    referencePrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,6}$/)
      .nullable()
      .optional(),
    locales: siteFields.locales.optional(),
    contact: SiteContact.nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.inventoryPolicy === undefined) !== (v.inventoryFilters === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['inventoryFilters'], message: 'send the policy and its filters together' });
    }
    policyFilters(v, ctx);
  });
export type UpdateSiteInput = z.infer<typeof UpdateSiteBody>;

export const SiteDto = z.object({
  id: z.uuid(),
  name: z.string(),
  domains: z.array(z.string()),
  mode: WebsiteMode,
  inventoryPolicy: InventoryPolicy,
  inventoryFilters: SiteInventoryFilters.nullable(),
  referencePrefix: z.string().nullable(),
  locales: z.array(z.string()),
  defaultLocale: z.string(),
  contact: SiteContact.nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SiteDto = z.infer<typeof SiteDto>;
export const SitePage = pageOf(SiteDto);
export type SitePage = z.infer<typeof SitePage>;

export const SiteParams = z.object({ siteId: z.uuid() });
export type SiteParams = z.infer<typeof SiteParams>;

// ── Per-site XML feeds (S7-07) ──────────────────────────────────────────────────────────────────────────────────

/**
 * The files of a site's XML feed (PLAN §9.5): `kyero.xml` (Kyero v3) and `inmolink.xml` (generic). Both carry the
 * site's inventory with the API's policy, white-label and overrides, refreshed when listings or the site change.
 */
export const SITE_FEED_FILES = ['kyero.xml', 'inmolink.xml'] as const;
export const SiteFeedFile = z.enum(SITE_FEED_FILES);
export type SiteFeedFile = z.infer<typeof SiteFeedFile>;

/** A feed token: 43 base64url characters (32 random bytes). Not an API key. */
export const SiteFeedToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `GET /v2/feeds/{token}/{file}` (feed-api). */
export const WebsiteFeedParams = z.object({ token: SiteFeedToken, file: SiteFeedFile });
export type WebsiteFeedParams = z.infer<typeof WebsiteFeedParams>;

/** A site's feed as the dashboard shows it: never the token, only its last characters. */
export const SiteFeedDto = z.strictObject({
  siteId: z.uuid(),
  /** false: no feed, or revoked (its URL answers 404). */
  enabled: z.boolean(),
  tokenHint: z.string().nullable(),
  tokenCreatedAt: z.iso.datetime().nullable(),
  generatedAt: z.iso.datetime().nullable(),
  /** Listings and units in the generic feed; those in the Kyero feed (priced sales and monthly or weekly rentals). */
  itemCount: z.number().int().nullable(),
  kyeroCount: z.number().int().nullable(),
  /** The last run failed (an error code); null after a success. */
  lastError: z.string().nullable(),
});
export type SiteFeedDto = z.infer<typeof SiteFeedDto>;

/** `POST /v1/sites/{id}/feed/token`: an optional `Idempotency-Key` — a retry within 24 h answers the same token. */
export const SiteFeedTokenHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .optional(),
});

/** A new or rotated token: shown once. `paths` are on the website API host (`/v2/feeds/<token>/<file>`). */
export const SiteFeedSecretDto = z.strictObject({
  feed: SiteFeedDto,
  token: SiteFeedToken,
  paths: z.strictObject({ kyero: z.string(), generic: z.string() }),
});
export type SiteFeedSecretDto = z.infer<typeof SiteFeedSecretDto>;

// ── Website API documents (S7-02) ───────────────────────────────────────────────────────────────────────────────

/**
 * Website listing documents (S7-02, PLAN §3 #6, §9.1, ADR 0012 #3): a read-model document as one site serves it —
 * white-labelled to the site's agency. Network listings carry the site's reference prefix and the presenting
 * agency's contacts; the owner's identity, contacts and commission are in no field (strict shapes), and owner text
 * on network listings has passed the white-label sanitizer. Texts are plain text, never HTML: render them escaped.
 */

/** The presenting agency (the site's): name, brand colours and the contacts buyers reach. */
export const WebsitePresenter = z.strictObject({
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  website: z.string().nullable(),
  primaryColor: z.string().nullable(),
  accentColor: z.string().nullable(),
});
export type WebsitePresenter = z.infer<typeof WebsitePresenter>;

/** An image with CDN URLs per size preset (the read model's variant keys behind the media CDN). */
export const WebsiteImage = z.strictObject({
  kind: ListingMediaKind,
  cover: z.boolean(),
  alt: z.string().nullable(),
  room: ListingRoomType.nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  urls: z.strictObject(Object.fromEntries(READ_MODEL_IMAGE_SIZES.map((s) => [s, z.string()]))).partial(),
});
export type WebsiteImage = z.infer<typeof WebsiteImage>;

/** Videos: own listings only (a network listing's video may show its owner, S7-02). */
export const WebsiteVideo = z.strictObject({ kind: z.literal('VIDEO'), provider: VideoProvider, id: z.string() });
export const WebsiteMedia = z.union([WebsiteImage, WebsiteVideo]);
export type WebsiteMedia = z.infer<typeof WebsiteMedia>;

/**
 * A development's reference on a site (S7-F6), like a listing's: the developer's own reference on the owner's sites,
 * `<prefix>-<code>` on every other site — `/v2/developments/{ref}` and the `development` search filter take it. Null
 * until known (the development's units' first rebuild with S7-F6).
 */
const DevelopmentRef = z.string().nullable();

export const WebsiteListingCard = ListingCardDoc.omit({ cover: true }).extend({
  cover: WebsiteImage.nullable(),
  developmentRef: DevelopmentRef,
});
export type WebsiteListingCard = z.infer<typeof WebsiteListingCard>;

export const WebsiteListingDetail = ListingDetailDoc.omit({ cover: true, media: true }).extend({
  cover: WebsiteImage.nullable(),
  developmentRef: DevelopmentRef,
  media: z.array(WebsiteMedia),
  agency: WebsitePresenter,
});
export type WebsiteListingDetail = z.infer<typeof WebsiteListingDetail>;

/** A unit's development as a site shows it: its reference (`/v2/developments/{ref}`) beside the shown id. */
const WebsiteUnitDevelopment = UnitCardDoc.shape.development.extend({ ref: DevelopmentRef });

export const WebsiteUnitCard = UnitCardDoc.extend({ development: WebsiteUnitDevelopment });
export type WebsiteUnitCard = z.infer<typeof WebsiteUnitCard>;

export const WebsiteUnitDetail = UnitDetailDoc.extend({
  development: WebsiteUnitDevelopment,
  agency: WebsitePresenter,
});
export type WebsiteUnitDetail = z.infer<typeof WebsiteUnitDetail>;

export const WebsiteCard = z.discriminatedUnion('kind', [WebsiteListingCard, WebsiteUnitCard]);
export type WebsiteCard = z.infer<typeof WebsiteCard>;
export const WebsiteDetail = z.discriminatedUnion('kind', [WebsiteListingDetail, WebsiteUnitDetail]);
export type WebsiteDetail = z.infer<typeof WebsiteDetail>;

/**
 * A new-build development as a site shows it (S7-F6, PLAN §9.1 `/v2/developments`): built from its units' public read
 * models — the development's name, texts, status, completion and place as its units carry them, with the price range
 * and unit counts of the units the site shows (AVAILABLE and RESERVED units of OPEN developments, within the site's
 * inventory). White-labelled like listings: a network development carries the site's reference and a site-scoped id,
 * sanitized owner text, and never its owner's id, reference, name or contacts.
 */
export const WebsiteDevelopmentCard = z.strictObject({
  kind: z.literal('DEVELOPMENT'),
  /** The development's id (another agency's: scoped to the site's agency, like listings). */
  id: z.uuid(),
  /** The owner's sites: the developer's own reference; every other site: `<prefix>-<code>` (`/v2/developments/{ref}`). */
  ref: z.string(),
  name: z.string(),
  title: z.string(),
  slug: z.string(),
  textLocale: z.string().nullable(),
  status: DevelopmentStatus,
  completionDate: z.string().nullable(),
  place: ReadModelPlace,
  geo: ReadModelGeo.nullable(),
  /** Prices of the AVAILABLE units with a price (null: none). */
  price: z.strictObject({
    fromCents: z.number().int().nonnegative().nullable(),
    toCents: z.number().int().nonnegative().nullable(),
    currency: z.string().length(3),
  }),
  bedrooms: z.strictObject({ min: z.number().int().nullable(), max: z.number().int().nullable() }),
  /** Units the site shows: AVAILABLE and RESERVED (sold units are not shown). */
  units: z.strictObject({
    total: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
  }),
});
export type WebsiteDevelopmentCard = z.infer<typeof WebsiteDevelopmentCard>;

export const WebsiteDevelopmentDetail = WebsiteDevelopmentCard.extend({
  description: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  agency: WebsitePresenter,
});
export type WebsiteDevelopmentDetail = z.infer<typeof WebsiteDevelopmentDetail>;

// ── Website API v2 read endpoints (S7-03) ───────────────────────────────────────────────────────────────────────

/**
 * Website API v2 (S7-03, PLAN §9.1): what a site's key reads — its inventory only (the site's policy, never a visitor
 * choice), white-labelled by the serializer. Lists page by opaque cursors; responses carry a strong ETag and answer
 * `If-None-Match` with 304.
 */

/** `?lang=`: a content locale of the site (default: the site's first). */
export const WebsiteLang = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
/**
 * `_k` (S7-06): the edge-cache token of the calling key and browser origin — base64url(SHA-256(`<api key>
<Origin or
 * empty>`)), first 22 characters; the SDK adds it. The origin answers `public` (CDN-cacheable) only when it matches the
 * request's key and origin, so cached URLs differ per key and origin even without the CDN's header rule. Optional and
 * otherwise ignored.
 */
export const EdgeKeyToken = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const edgeKey = { _k: EdgeKeyToken.optional() };

export const WebsiteLangQuery = z.strictObject({ lang: WebsiteLang.optional(), ...edgeKey });
export type WebsiteLangQuery = z.infer<typeof WebsiteLangQuery>;

/** A comma-separated query value (`?types=a,b`) → its trimmed, non-empty items. */
const csv = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((x) => x.trim())
            .filter((x) => x !== '')
        : v,
    z.array(item).min(1).max(max),
  );
const QueryAmount = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const QueryCount = z.coerce.number().int().min(0).max(50);
const QueryArea = z.coerce.number().min(0).max(1_000_000);

/** `?bbox=north,west,south,east` (map view). */
const BoundingBox = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((x) => Number(x.trim())) : v),
  z
    .tuple([
      z.number().min(-90).max(90),
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
      z.number().min(-180).max(180),
    ])
    .refine(([north, , south]) => south <= north, { message: 'south must not be above north' }),
);

/**
 * `GET /v2/listings`: a visitor's filters as a query string (lists comma-separated). The site's inventory is applied
 * on top, server-side.
 */
export const WebsiteListingsQuery = z.strictObject({
  ...edgeKey,
  /** Free text in `lang`, or a reference as the site shows it (`CH-123`, `W-7KQ2M9XA`). */
  q: z.string().trim().min(1).max(100).optional(),
  lang: WebsiteLang.optional(),
  kind: z.enum(['LISTING', 'UNIT']).optional(),
  /** An own development's units and listings by its id (network developments: `development`). */
  developmentId: z.uuid().optional(),
  /**
   * A development's units and listings by the reference the site shows (S7-F6): an own development's own reference,
   * another agency's `<prefix>-<code>`.
   */
  development: z.string().min(1).max(64).regex(/^\S+$/).optional(),
  status: csv(PublicSearchStatus, PUBLIC_SEARCH_STATUSES.length).optional(),
  transaction: TransactionType.optional(),
  /** Any of these property types. */
  types: csv(z.uuid(), 50).optional(),
  /** Anywhere under any of these locations. */
  locations: csv(z.uuid(), 50).optional(),
  /** Every one of these features. */
  features: csv(z.uuid(), 20).optional(),
  priceMin: QueryAmount.optional(),
  priceMax: QueryAmount.optional(),
  bedsMin: QueryCount.optional(),
  bathsMin: QueryCount.optional(),
  areaMin: QueryArea.optional(),
  areaMax: QueryArea.optional(),
  bbox: BoundingBox.optional(),
  facets: csv(PublicSearchFacet, PUBLIC_SEARCH_FACETS.length).optional(),
  sort: PublicSearchSort.default('newest'),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: Cursor.optional(),
});
export type WebsiteListingsQuery = z.infer<typeof WebsiteListingsQuery>;

export const WebsiteListingPage = z.strictObject({
  items: z.array(WebsiteCard),
  /** Matching listings: exact up to 10,000, or up to 1,000 while search runs degraded (`degraded`). */
  total: z.number().int(),
  /** Value → count per requested facet; empty while degraded. */
  facets: z.record(z.string(), z.record(z.string(), z.number().int())),
  nextCursor: Cursor.nullable(),
  /** Answered by the Postgres fallback (simpler ranking, no facets, totals capped at 1,000). */
  degraded: z.boolean(),
  /** The results changed under pagination (show them as fresh results, not as the next page). */
  resultsChanged: z.literal(true).optional(),
});
export type WebsiteListingPage = z.infer<typeof WebsiteListingPage>;

// ── S12-08: AI search ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * `GET /v2/search/ai` (S12-08, PLAN §9.1 / §8 #3): a visitor's sentence in any language, understood as `/v2/listings`
 * filters. Next pages: the same `q` with the page's `cursor` (the same sentence is understood the same way).
 */
export const WebsiteAiSearchQuery = z.strictObject({
  ...edgeKey,
  q: z.string().trim().min(1).max(300),
  lang: WebsiteLang.optional(),
  facets: csv(PublicSearchFacet, PUBLIC_SEARCH_FACETS.length).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: Cursor.optional(),
});
export type WebsiteAiSearchQuery = z.infer<typeof WebsiteAiSearchQuery>;

/** The filters the sentence was understood as — the `/v2/listings` query parameters, ready to show as chips. */
export const WebsiteAiSearchFilters = z.strictObject({
  q: z.string().optional(),
  kind: z.enum(['LISTING', 'UNIT']).optional(),
  transaction: TransactionType.optional(),
  types: z.array(z.uuid()).optional(),
  locations: z.array(z.uuid()).optional(),
  features: z.array(z.uuid()).optional(),
  priceMin: z.number().int().optional(),
  priceMax: z.number().int().optional(),
  bedsMin: z.number().int().optional(),
  bathsMin: z.number().int().optional(),
  areaMin: z.number().optional(),
  areaMax: z.number().optional(),
  sort: PublicSearchSort.optional(),
});
export type WebsiteAiSearchFilters = z.infer<typeof WebsiteAiSearchFilters>;

export const WebsiteAiSearchPage = WebsiteListingPage.extend({
  understood: z.strictObject({
    /** `AI`: filters from the sentence. `KEYWORD`: AI unavailable, slow or out of budget, or nothing understood — the words searched as free text. */
    source: z.enum(['AI', 'KEYWORD']),
    filters: WebsiteAiSearchFilters,
    /** Places, types or features named that this site's taxonomy does not know (places are searched as text). */
    unmatched: z.array(z.string()),
  }),
});
export type WebsiteAiSearchPage = z.infer<typeof WebsiteAiSearchPage>;

/** `GET /v2/listings/{ref}`: a reference as the site shows it. */
export const WebsiteListingParams = z.strictObject({ ref: z.string().min(1).max(64).regex(/^\S+$/) });
export type WebsiteListingParams = z.infer<typeof WebsiteListingParams>;

/**
 * `GET /v2/changes`: the site's delta feed. Start with `since` (an ISO time; a starting point — changes shortly before
 * it may be included) or continue with `cursor` (exact: every change exactly once, in commit order).
 */
export const WebsiteChangesQuery = z
  .strictObject({
    ...edgeKey,
    since: z.iso.datetime({ offset: true }).optional(),
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(1_000).default(200),
  })
  .refine((q) => (q.since === undefined) !== (q.cursor === undefined), {
    message: 'either since or cursor',
    path: ['since'],
  });
export type WebsiteChangesQuery = z.infer<typeof WebsiteChangesQuery>;

export const WebsiteChange = z.strictObject({
  /** The reference as the site shows it (`/v2/listings/{ref}`). */
  ref: z.string(),
  kind: z.enum(['LISTING', 'UNIT']),
  /** UPSERT: shown now — fetch it again; REMOVE: no longer on this site (also sent for listings it never showed). */
  change: z.enum(['UPSERT', 'REMOVE']),
  changedAt: z.iso.datetime(),
});
export type WebsiteChange = z.infer<typeof WebsiteChange>;

export const WebsiteChangesPage = z.strictObject({
  items: z.array(WebsiteChange),
  /** Always present: poll with it later (it stays put when nothing changed). */
  nextCursor: Cursor,
  /** More changes are ready now: ask again with `nextCursor` at once. */
  hasMore: z.boolean(),
  /**
   * The site's inventory rules (policy, network standing). When it differs from the last page's, the site's selection
   * changed as a whole: rebuild the cache from `/v2/sitemap`.
   */
  scope: z.string(),
});
export type WebsiteChangesPage = z.infer<typeof WebsiteChangesPage>;

/**
 * `GET /v2/sitemap`: the site's listing pages, one page per `cursor`. S7-F10 review: 250 per page by default, at most
 * 500 (was 500 / 1,000) — a network page's cost is serving its entries white-labelled (~25 ms of a 500-entry page against
 * ~5 ms of SQL), and a sitemap is read by following cursors anyway.
 */
export const WebsiteSitemapQuery = z.strictObject({
  ...edgeKey,
  lang: WebsiteLang.optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(250),
});
export type WebsiteSitemapQuery = z.infer<typeof WebsiteSitemapQuery>;

export const WebsiteSitemapEntry = z.strictObject({
  ref: z.string(),
  /** S8-F24: `DEVELOPMENT` entries (the site's new-build developments) follow the listing pages. */
  kind: z.enum(['LISTING', 'UNIT', 'DEVELOPMENT']),
  /** The page's slug in `lang` (network listings: from the title the site shows). */
  slug: z.string(),
  updatedAt: z.iso.datetime(),
});
export type WebsiteSitemapEntry = z.infer<typeof WebsiteSitemapEntry>;

export const WebsiteSitemapPage = pageOf(WebsiteSitemapEntry);
export type WebsiteSitemapPage = z.infer<typeof WebsiteSitemapPage>;

// ── Website API v2 developments (S7-F6) ─────────────────────────────────────────────────────────────────────────

/** `GET /v2/developments`: the site's new-build developments, newest first, one page per `cursor`. */
export const WebsiteDevelopmentsQuery = z.strictObject({
  ...edgeKey,
  lang: WebsiteLang.optional(),
  /** Anywhere under any of these locations. */
  locations: csv(z.uuid(), 50).optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
export type WebsiteDevelopmentsQuery = z.infer<typeof WebsiteDevelopmentsQuery>;

export const WebsiteDevelopmentPage = z.strictObject({
  items: z.array(WebsiteDevelopmentCard),
  nextCursor: Cursor.nullable(),
});
export type WebsiteDevelopmentPage = z.infer<typeof WebsiteDevelopmentPage>;

/** `GET /v2/developments/{ref}`: a development by the reference the site shows. */
export const WebsiteDevelopmentParams = WebsiteListingParams;
export type WebsiteDevelopmentParams = z.infer<typeof WebsiteDevelopmentParams>;

/** `GET /v2/developments/{ref}/units`: the live unit table, in the developer's unit order, one page per `cursor`. */
export const WebsiteUnitsQuery = z.strictObject({
  ...edgeKey,
  lang: WebsiteLang.optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type WebsiteUnitsQuery = z.infer<typeof WebsiteUnitsQuery>;

export const WebsiteUnitPage = z.strictObject({
  items: z.array(WebsiteUnitCard),
  nextCursor: Cursor.nullable(),
});
export type WebsiteUnitPage = z.infer<typeof WebsiteUnitPage>;
