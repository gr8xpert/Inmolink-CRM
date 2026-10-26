/**
 * Website search (S5-04, PLAN §5.4, ADR 0005 #5): a site's filters → ids, from the search engine or, when it is down
 * or slow, from the Postgres fallback (`listing_search_docs`). Both run the same engine-neutral filter, so results
 * match; the fallback ranks more simply (the sort only), matches text against references only and has no facets.
 *
 * Timing comes from config (`websiteSearchEnv`, set at boot by `configureWebsiteSearch`; S6-F3): an engine call is
 * cut at `SEARCH_ENGINE_TIMEOUT_MS` (~100 ms); at `SEARCH_SLOW_MS` (~50 ms) without an answer the fallback starts
 * beside it and the first answer wins, so a slow engine never costs a request more than about the slow threshold plus
 * one fallback statement. A circuit breaker per process counts an engine call that fails, times out or answers slower
 * than `SEARCH_SLOW_MS`: `SEARCH_BREAKER_FAILURES` in a row, or a failed-or-slow share ≥ `SEARCH_BREAKER_FAILURE_RATIO`
 * of ≥ `SEARCH_BREAKER_MIN_CALLS` calls within `SEARCH_BREAKER_WINDOW_MS`, switch every request to the fallback for
 * `SEARCH_BREAKER_OPEN_MS`, then one request probes the engine. A request whose own engine call fails is answered by
 * the fallback at once: a site never sees the engine's outage as an error.
 *
 * Metrics: `inmolink.search.queries` (counter; `backend` engine | fallback, `reason` for the fallback) and
 * `inmolink.search.breaker.open` (gauge, 1 while the breaker is not closed); alert `SearchFallbackActive`
 * (infra/monitoring/rules/search.yml). Public path: reads as `app_public`, never inside a caller's transaction.
 */
import {
  PublicCode,
  PublicListingSearch,
  type PublicListingSearchResult,
  type PublicSearchSort,
} from '@inmolink/contracts';
import { type Tx, withPublicRead } from '@inmolink/db';
import { LocalLru } from '@inmolink/platform/cache';
import { AppError } from '@inmolink/platform/errors';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import {
  type BreakerOptions,
  type BreakerState,
  CircuitBreaker,
  type Filter,
  type SearchEngine,
  SearchError,
  searchEngine,
} from '@inmolink/platform/search';
import { metrics } from '@opentelemetry/api';
import { z } from 'zod';
import { attributeFilters, othersInNetwork, sharesWith } from './filters';
import { listingsIndex } from './index-doc';
import { listingsIndexUid } from './indexer';
import * as repo from './repo';

/**
 * Website search timing (S6-F3): the defaults of `websiteSearchEnv` (platform config); apps set them from config at
 * boot (`configureWebsiteSearch`).
 */
export interface WebsiteSearchSettings {
  /** Longest wait for one engine query before the request is answered by the fallback. */
  engineTimeoutMs: number;
  /** No engine answer by then: the fallback starts beside it (first answer wins); a slower answer counts against it. */
  slowMs: number;
  /** Failed or slow engine queries in a row that switch to the fallback. */
  breakerFailures: number;
  /** …or this share of failed or slow queries among `breakerMinCalls` or more within `breakerWindowMs`. */
  breakerFailureRatio: number;
  breakerMinCalls: number;
  breakerWindowMs: number;
  /** How long the fallback serves alone before one request probes the engine again. */
  breakerOpenMs: number;
  /**
   * Fallback statements started beside a slow engine at once in this process: the losing statement is not cancelled,
   * so while the engine is slow but the breaker still closed this bounds the extra Postgres load. Past it a request
   * waits for the engine (up to its timeout).
   */
  hedgeMaxInFlight: number;
  /**
   * Free text matches network documents (S7-F5). Off while the index still holds text from before white-labelled
   * indexing (the deploy's reindex): free text then matches the site's own documents only; network documents are
   * still found by filters and by their `<prefix>-<code>` reference.
   */
  networkFreeText: boolean;
}

export const WEBSITE_SEARCH_DEFAULTS: Readonly<WebsiteSearchSettings> = {
  engineTimeoutMs: 100,
  slowMs: 50,
  breakerFailures: 5,
  breakerFailureRatio: 0.5,
  breakerMinCalls: 10,
  breakerWindowMs: 10_000,
  breakerOpenMs: 30_000,
  hedgeMaxInFlight: 16,
  networkFreeText: true,
};

let settings: WebsiteSearchSettings = { ...WEBSITE_SEARCH_DEFAULTS };

/** The timing in force in this process (tests, health pages). */
export const websiteSearchSettings = (): Readonly<WebsiteSearchSettings> => settings;
/** Totals are exact up to this many results (the engine's `maxTotalHits`), and no page goes deeper. */
export const SEARCH_RESULT_CAP = 10_000;
/**
 * Fallback totals are exact up to this many: counting reads every matching row, scattered over the table, so the
 * degraded mode counts less (a site shows "1,000+").
 */
export const FALLBACK_COUNT_CAP = 1_000;

const SORTS: Record<PublicSearchSort, { field: string; dir: 'asc' | 'desc' }> = {
  newest: { field: 'publishedAt', dir: 'desc' },
  price_asc: { field: 'priceCents', dir: 'asc' },
  price_desc: { field: 'priceCents', dir: 'desc' },
  beds_desc: { field: 'beds', dir: 'desc' },
  area_desc: { field: 'areaM2', dir: 'desc' },
};

let log: Logger | undefined;
const logger = () => {
  log ??= createLogger({ service: 'search' });
  return log;
};

const meter = metrics.getMeter('@inmolink/core');
const queries = meter.createCounter('inmolink.search.queries', {
  description: 'Website search queries by the backend that answered (engine | fallback) and why it fell back',
});
const transitions = meter.createCounter('inmolink.search.breaker.transitions', {
  description: 'Search circuit breaker state changes',
});

function newBreaker(options: Partial<BreakerOptions> = {}): CircuitBreaker {
  return new CircuitBreaker({
    failureThreshold: settings.breakerFailures,
    openMs: settings.breakerOpenMs,
    slowMs: settings.slowMs,
    window: {
      windowMs: settings.breakerWindowMs,
      minCalls: settings.breakerMinCalls,
      failureRatio: settings.breakerFailureRatio,
    },
    ...options,
    onChange: (to: BreakerState, from: BreakerState) => {
      transitions.add(1, { to });
      const fields = { from, to };
      if (to === 'open') logger().warn(fields, 'search engine unavailable: website search uses the Postgres fallback');
      else logger().info(fields, 'search circuit breaker changed');
      options.onChange?.(to, from);
    },
  });
}

let breaker = newBreaker();
meter
  .createObservableGauge('inmolink.search.breaker.open', {
    description: '1 while website search skips the engine (breaker open), else 0',
  })
  // Open only: a half-open breaker with no traffic is not serving the fallback (its next request probes).
  .addCallback((r) => r.observe(breaker.state === 'open' ? 1 : 0));

/** The breaker's state in this process (health pages, tests). */
export const searchBreakerState = (): BreakerState => breaker.state;

/** Tests: a fresh breaker, optionally with other thresholds or clock. */
export function resetSearchBreaker(options: Partial<BreakerOptions> = {}): void {
  breaker = newBreaker(options);
}

/**
 * Boot (S6-F3): the timing from config (`SEARCH_ENGINE_TIMEOUT_MS`, `SEARCH_SLOW_MS`, `SEARCH_BREAKER_*`); omitted
 * values keep the defaults. Starts a fresh breaker. The slow threshold must be below the timeout (else the fallback
 * would never start beside a slow engine).
 */
export function configureWebsiteSearch(options: Partial<WebsiteSearchSettings>): void {
  const next = { ...WEBSITE_SEARCH_DEFAULTS, ...options };
  if (next.slowMs >= next.engineTimeoutMs) {
    throw new RangeError('website search: SEARCH_SLOW_MS must be below SEARCH_ENGINE_TIMEOUT_MS');
  }
  settings = next;
  breaker = newBreaker();
}

type Parsed = ReturnType<typeof PublicListingSearch.parse>;

/**
 * A CUSTOM inventory policy's narrowing (S7-01): anywhere under any of the locations, any of the types, an inclusive
 * price band (listings on request fall outside a band), new-build units on or off, and a minimum commission on
 * network listings. Empty lists: no narrowing.
 */
export interface SiteRestriction {
  locationIds?: readonly string[];
  propertyTypeIds?: readonly string[];
  priceMinCents?: number;
  priceMaxCents?: number;
  /** false: listings only, no new-build units. */
  newBuilds?: boolean;
  /**
   * Network listings only (S7-F4): at least this total commission in basis points of the price. Own listings are never
   * filtered by it; a network listing with no commission or an unknown share (a fixed amount of an on-request price)
   * falls outside.
   */
  minCommissionBp?: number;
}

/** Who searches: the site's inventory from its policy (S7-01, `websites.siteSearchScope`) — never from the visitor. */
export interface PublicSearchSite {
  /**
   * Listings of these owner agencies; null: every agency's PUBLIC listings (a network-wide site). May be empty only
   * with `networkOf` (a site showing network listings alone).
   */
  ownerAgencyIds: readonly string[] | null;
  /**
   * Also the PUBLIC listings and units other agencies share with this agency (OWN_PLUS_NETWORK): shared with
   * everyone, or by an owner that prefers it, and not hidden from the network for freshness (S6-F2).
   */
  networkOf?: string;
  /**
   * The prefix network documents carry on this site (S7-02, `websites.networkRefPrefix`): a visitor finds a network
   * document by `<prefix>-<public code>` only, never by the owner's own reference. Without it no network document is found
   * by reference.
   */
  networkRefPrefix?: string;
  restrict?: SiteRestriction;
  /**
   * S15-01: never these owners' documents (the portal leaves out agencies that are not listed in the directory). A
   * filter in the query, so totals, facets and pages stay right.
   */
  excludeOwnerAgencyIds?: readonly string[];
  /** Correlates the engine-failure logs with the request. */
  requestId: string;
}

const MAX_RESTRICT_IDS = 50;
/**
 * Most owner ids a search names, to show or to leave out (S15-01: the portal names the listed agencies, or the unlisted
 * owners of search documents, whichever set is smaller). Sites name a handful.
 */
export const MAX_EXCLUDED_OWNERS = 5_000;
const PublicSearchSite = z
  .object({
    ownerAgencyIds: z.array(z.uuid()).max(MAX_EXCLUDED_OWNERS).nullable(),
    networkOf: z.uuid().optional(),
    networkRefPrefix: z
      .string()
      .regex(/^[A-Z0-9]{1,6}$/)
      .optional(),
    restrict: z
      .object({
        locationIds: z.array(z.uuid()).max(MAX_RESTRICT_IDS).optional(),
        propertyTypeIds: z.array(z.uuid()).max(MAX_RESTRICT_IDS).optional(),
        priceMinCents: z.number().int().min(0).optional(),
        priceMaxCents: z.number().int().min(0).optional(),
        newBuilds: z.boolean().optional(),
        minCommissionBp: z.number().int().min(1).max(10_000).optional(),
      })
      .optional(),
    excludeOwnerAgencyIds: z.array(z.uuid()).max(MAX_EXCLUDED_OWNERS).optional(),
    requestId: z.string().max(200),
  })
  .refine((s) => (s.ownerAgencyIds === null ? !s.networkOf : s.ownerAgencyIds.length > 0 || !!s.networkOf), {
    message: 'a site shows a network-wide inventory, or its owners and/or its network',
  });

/** Engine cursor: an offset · fallback cursor: the last row's position (keyset). Both carry the sort. */
type CursorState = { s: PublicSearchSort; o: number } | { s: PublicSearchSort; p: 0 | 1; v: number | null; i: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sorts whose column is never null (no phase 1), and sorts on whole numbers (their cursor value must be one). */
const NEVER_NULL: ReadonlySet<PublicSearchSort> = new Set(['newest']);
const WHOLE: ReadonlySet<PublicSearchSort> = new Set(['newest', 'price_asc', 'price_desc', 'beds_desc']);
const MAX_SORT_VALUE = 1e15;

const encode = (c: CursorState) => Buffer.from(JSON.stringify(c)).toString('base64url');

/**
 * The engine cursor of the page starting `offset` results down (S8-02: the v1 shim's legacy `page` numbers). Undefined
 * for the first page. Past `SEARCH_RESULT_CAP` there is no page (null). In the Postgres fallback an engine cursor
 * restarts at the first keyset page with `resultsChanged` (the fallback never runs an SQL OFFSET, S6-F2).
 */
export function searchOffsetCursor(sort: PublicSearchSort, offset: number): string | undefined | null {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer');
  if (offset === 0) return undefined;
  if (offset >= SEARCH_RESULT_CAP) return null;
  return encode({ s: sort, o: offset });
}

/** A cursor this sort could have produced, or VALIDATION_FAILED: a forged one never reaches SQL as a type error. */
function decode(cursor: string | undefined, sort: PublicSearchSort): CursorState | undefined {
  if (cursor === undefined) return undefined;
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (c.s === sort) {
      if (Number.isInteger(c.o) && (c.o as number) > 0 && (c.o as number) < SEARCH_RESULT_CAP) {
        return { s: sort, o: c.o as number };
      }
      const id = typeof c.i === 'string' && UUID.test(c.i) ? c.i : null;
      const v = c.v;
      const valueOk =
        typeof v === 'number' &&
        Math.abs(v) <= MAX_SORT_VALUE &&
        (WHOLE.has(sort) ? Number.isInteger(v) : Number.isFinite(v));
      if (id && c.p === 0 && valueOk) return { s: sort, p: 0, v: v as number, i: id };
      if (id && c.p === 1 && v === null && !NEVER_NULL.has(sort)) return { s: sort, p: 1, v: null, i: id };
    }
  } catch {
    // falls through to the error below
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

/** Other agencies' documents shared with `agencyId`: the network search's rule (`filters.ts`), for PUBLIC documents. */
function sharedWith(agencyId: string): Filter {
  return { op: 'and', filters: [...othersInNetwork(agencyId), sharesWith(agencyId)] };
}

/** A site whose results mix its own documents with other agencies' (white-labelled references, S7-02). */
const whiteLabelled = (site: Pick<PublicSearchSite, 'ownerAgencyIds' | 'networkOf'>) =>
  site.ownerAgencyIds !== null && site.networkOf !== undefined;

/**
 * A reference typed in the search box as a filter (S7-02, PLAN §9.1 white-label): the site's own documents match
 * their reference (`ref`); a network document matches only the site's form `<prefix>-<public code>` (`publicCode`),
 * so a visitor never finds it by the owner's own reference. Null: no document can match (a network-only site, text without the
 * site's prefix). A site without network documents matches references as they are.
 */
export function refFilter(
  site: Pick<PublicSearchSite, 'ownerAgencyIds' | 'networkOf' | 'networkRefPrefix'>,
  text: string,
): Filter | null {
  if (!whiteLabelled(site)) return { op: 'eq', field: 'ref', value: text };
  const own = site.ownerAgencyIds ?? [];
  const marker = site.networkRefPrefix ? `${site.networkRefPrefix}-`.toUpperCase() : null;
  // The public code after the site's prefix (codes are upper case; never the owner's own reference).
  const networkCode =
    marker && text.length > marker.length && text.toUpperCase().startsWith(marker)
      ? text.slice(marker.length).toUpperCase()
      : null;
  const ownAgencies: Filter = { op: 'in', field: 'ownerAgencyId', values: [...own] };
  const branches: Filter[] = [];
  if (own.length > 0) {
    branches.push({ op: 'and', filters: [ownAgencies, { op: 'eq', field: 'ref', value: text }] });
  }
  if (networkCode !== null) {
    branches.push({
      op: 'and',
      filters: [
        ...(own.length > 0 ? [{ op: 'not', filter: ownAgencies } as const] : []),
        { op: 'eq', field: 'publicCode', value: networkCode },
      ],
    });
  }
  if (branches.length === 0) return null;
  return branches.length === 1 ? (branches[0] as Filter) : { op: 'or', filters: branches };
}

/**
 * The public code in `<site prefix>-<code>` (prefix and code in any case), or null: not the site's network form. Only
 * sites with network documents have one (`networkRefPrefix`).
 */
function codeAfterPrefix(site: Pick<PublicSearchSite, 'networkRefPrefix'>, text: string): string | null {
  if (!site.networkRefPrefix) return null;
  const marker = `${site.networkRefPrefix}-`.toUpperCase();
  if (text.length <= marker.length || text.slice(0, marker.length).toUpperCase() !== marker) return null;
  const code = text.slice(marker.length).toUpperCase();
  return PublicCode.safeParse(code).success ? code : null;
}

/**
 * What a development reference names on a site (S7-F6, like `refFilter` for listings): an own development by its
 * developer's own reference, another agency's only by `<prefix>-<public code>` — never by its owner's reference, and
 * the owner's sites never by the network form (the code is the presenting agency's, ADR 0012 #3).
 */
export function developmentRefMatch(
  site: Pick<PublicSearchSite, 'ownerAgencyIds' | 'networkOf' | 'networkRefPrefix'>,
  text: string,
): { ownRef: string | null; code: string | null } {
  const own = site.ownerAgencyIds;
  const hasOwn = own === null || own.length > 0;
  const code = whiteLabelled(site) || own?.length === 0 ? codeAfterPrefix(site, text) : null;
  return { ownRef: hasOwn ? text : null, code };
}

/** A development reference as a search filter (`?development=`); null: it can name nothing on this site. */
function developmentRefFilter(
  site: Pick<PublicSearchSite, 'ownerAgencyIds' | 'networkOf' | 'networkRefPrefix'>,
  text: string,
): Filter | null {
  const match = developmentRefMatch(site, text);
  const own = site.ownerAgencyIds;
  const ownAgencies: Filter | null =
    own === null || own.length === 0 ? null : { op: 'in', field: 'ownerAgencyId', values: [...own] };
  const branches: Filter[] = [];
  if (match.ownRef !== null) {
    const byRef: Filter = { op: 'eq', field: 'developmentOwnRef', value: match.ownRef };
    branches.push(ownAgencies ? { op: 'and', filters: [ownAgencies, byRef] } : byRef);
  }
  if (match.code !== null) {
    const byCode: Filter = { op: 'eq', field: 'developmentCode', value: match.code };
    branches.push(ownAgencies ? { op: 'and', filters: [{ op: 'not', filter: ownAgencies }, byCode] } : byCode);
  }
  if (branches.length === 0) return null;
  return branches.length === 1 ? (branches[0] as Filter) : { op: 'or', filters: branches };
}

/** Matches nothing (a reference or development that is not the site's). */
const NOTHING: Filter = { op: 'eq', field: 'developmentId', value: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };

/** Text that may be a reference: one word (references have no spaces). */
const REF_LIKE = /^\S{1,64}$/;
/** Most hits a reference lookup returns. */
const REF_LOOKUP_LIMIT = 10;

const nonEmpty = (ids: readonly string[] | undefined) => (ids && ids.length > 0 ? [...ids] : undefined);

/** A site's search as one engine-neutral filter: PUBLIC documents of the site's inventory only. */
export function publicSearchFilter(
  site: Pick<
    PublicSearchSite,
    'ownerAgencyIds' | 'networkOf' | 'restrict' | 'networkRefPrefix' | 'excludeOwnerAgencyIds'
  >,
  q: Parsed,
): Filter {
  const filters: Filter[] = [
    { op: 'eq', field: 'visibility', value: 'PUBLIC' },
    { op: 'in', field: 'status', values: q.statuses },
  ];
  if (site.excludeOwnerAgencyIds && site.excludeOwnerAgencyIds.length > 0) {
    filters.push({ op: 'not', filter: { op: 'in', field: 'ownerAgencyId', values: [...site.excludeOwnerAgencyIds] } });
  }
  if (site.ownerAgencyIds) {
    const whose: Filter[] = [];
    if (site.ownerAgencyIds.length > 0) {
      whose.push({ op: 'in', field: 'ownerAgencyId', values: [...site.ownerAgencyIds] });
    }
    if (site.networkOf) {
      const network = sharedWith(site.networkOf);
      const min = site.restrict?.minCommissionBp;
      // The minimum commission narrows the network branch alone (S7-F4); a null commission matches no range.
      whose.push(
        min === undefined
          ? network
          : { op: 'and', filters: [network, { op: 'range', field: 'commissionBp', gte: min }] },
      );
    }
    filters.push(whose.length === 1 ? (whose[0] as Filter) : { op: 'or', filters: whose });
  }
  const r = site.restrict;
  if (r) {
    filters.push(
      ...attributeFilters({
        locationIds: nonEmpty(r.locationIds),
        propertyTypeIds: nonEmpty(r.propertyTypeIds),
        priceMinCents: r.priceMinCents,
        priceMaxCents: r.priceMaxCents,
        kind: r.newBuilds === false ? 'LISTING' : undefined,
      }),
    );
  }
  filters.push(...attributeFilters(q));
  // The raw development id (cards show other agencies' developments scoped): the site's own developments only.
  if (q.developmentId && site.ownerAgencyIds !== null) {
    filters.push(
      site.ownerAgencyIds.length > 0 ? { op: 'in', field: 'ownerAgencyId', values: [...site.ownerAgencyIds] } : NOTHING,
    );
  }
  if (q.developmentRef !== undefined) {
    filters.push(developmentRefFilter(site, q.developmentRef) ?? NOTHING);
  }
  return { op: 'and', filters };
}

/**
 * Website search: ids of the PUBLIC listings and units of the site's inventory matching a visitor's filters, one page
 * per `cursor`, from the engine or the Postgres fallback (`backend`). Never fails because the engine does.
 */
export async function searchPublicListings(
  site: PublicSearchSite,
  input: PublicListingSearch,
  options: { engine?: SearchEngine } = {},
): Promise<PublicListingSearchResult> {
  const scope = PublicSearchSite.parse(site);
  const q = PublicListingSearch.parse(input);
  const cursor = decode(q.cursor, q.sort);
  const filter = publicSearchFilter(scope, q);
  // A fallback page continues in the fallback (its keyset order), even when the engine is back.
  if (cursor && 'p' in cursor) return fallback(scope, q, filter, cursor, 'cursor');
  const permit = breaker.acquire();
  if (!permit) return fallback(scope, q, filter, cursor, 'breaker_open');
  const started = performance.now();
  const engineCall = engineSearch(options.engine ?? searchEngine(), scope, q, filter, cursor?.o ?? 0).then(
    (result) => {
      permit.success(performance.now() - started);
      return result;
    },
    (err: unknown) => {
      permit.failure();
      // Code and status only: an adapter error may carry the request body (the visitor's text).
      logger().warn(
        {
          requestId: scope.requestId,
          error: err instanceof Error ? err.name : typeof err,
          ...(err instanceof SearchError ? { code: err.code, status: err.status } : {}),
        },
        'search engine query failed: answered by the Postgres fallback',
      );
      throw err;
    },
  );
  // The engine's answer within the slow threshold, or null: still waiting.
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), settings.slowMs);
  });
  try {
    const early = await Promise.race([engineCall, slow]);
    if (early) {
      queries.add(1, { backend: 'engine' });
      return early;
    }
  } catch {
    return fallback(scope, q, filter, cursor, 'engine_error');
  } finally {
    clearTimeout(timer);
  }
  // Slow (S6-F3): the fallback starts beside the engine and the first answer wins. The engine call keeps its own
  // deadline and reports its outcome to the breaker whichever wins. Too many hedges already running: wait for it.
  if (hedging >= settings.hedgeMaxInFlight) {
    try {
      const late = await engineCall;
      queries.add(1, { backend: 'engine' });
      return late;
    } catch {
      return fallback(scope, q, filter, cursor, 'engine_error');
    }
  }
  hedging += 1;
  const backup = fallbackPage(scope, q, filter, cursor).finally(() => {
    hedging -= 1;
  });
  try {
    const first = await Promise.any([engineCall, backup]);
    queries.add(1, first.backend === 'engine' ? { backend: 'engine' } : { backend: 'fallback', reason: 'engine_slow' });
    return first;
  } catch {
    // Both failed: the fallback's error is the request's (the engine's is logged above).
    return backup;
  }
}

/** Fallback statements running beside a slow engine in this process (`hedgeMaxInFlight`). */
let hedging = 0;

/**
 * Development references → development ids for the engine (S7-F6): the index has no code or development-reference
 * field, so a `developmentCode` / `developmentOwnRef` filter is resolved first — one statement per reference a process
 * has not seen. A code never changes or moves (kept a day); an own reference can be edited (kept a minute). Unknown
 * references sit in a small cache of their own (a minute), so made-up ones cannot push known ones out. With the
 * breaker open no engine call is made and the fallback resolves the reference inside its own statement.
 */
const developmentOfCode = new LocalLru<string[]>(20_000);
const developmentsOfOwnRef = new LocalLru<string[]>(5_000);
const unknownReferences = new LocalLru<true>(1_000);
const DEVELOPMENT_CODE_TTL_MS = 24 * 3_600_000;
const OWN_REF_TTL_MS = 60_000;
const UNKNOWN_REFERENCE_TTL_MS = 60_000;
/** Matches no development: an unknown reference finds nothing (not the platform agency's nil id). */
const NO_DEVELOPMENT = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** Tests: forget resolved development references. */
export function resetDevelopmentCodes(): void {
  developmentOfCode.clear();
  developmentsOfOwnRef.clear();
  unknownReferences.clear();
}

const refKey = (field: 'developmentCode' | 'developmentOwnRef', value: string) =>
  `${field}:${field === 'developmentOwnRef' ? value.toLowerCase() : value}`;
const cacheOf = (field: 'developmentCode' | 'developmentOwnRef') =>
  field === 'developmentCode' ? developmentOfCode : developmentsOfOwnRef;

/** The development ids of these references: cached, else every missing one resolved in one statement. */
async function developmentsOf(
  refs: readonly { field: 'developmentCode' | 'developmentOwnRef'; value: string }[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const missing: { field: 'developmentCode' | 'developmentOwnRef'; value: string }[] = [];
  for (const r of refs) {
    const key = refKey(r.field, r.value);
    const hit = cacheOf(r.field).get(key);
    if (hit) out.set(key, hit);
    else if (unknownReferences.get(key)) out.set(key, []);
    else missing.push(r);
  }
  if (missing.length === 0) return out;
  const found = await withPublicRead((tx) =>
    repo.resolveDevelopmentRefs(
      tx,
      missing.filter((r) => r.field === 'developmentCode').map((r) => r.value),
      missing.filter((r) => r.field === 'developmentOwnRef').map((r) => r.value),
    ),
  );
  for (const r of missing) {
    const key = refKey(r.field, r.value);
    const ids =
      (r.field === 'developmentCode' ? found.codes.get(r.value) : found.ownRefs.get(r.value.toLowerCase())) ?? [];
    if (ids.length === 0) unknownReferences.set(key, true, UNKNOWN_REFERENCE_TTL_MS);
    else cacheOf(r.field).set(key, ids, r.field === 'developmentCode' ? DEVELOPMENT_CODE_TTL_MS : OWN_REF_TTL_MS);
    out.set(key, ids);
  }
  return out;
}

/** The filter with development references replaced by the development ids they name (engine only). */
async function engineFilter(filter: Filter): Promise<Filter> {
  const refs: { field: 'developmentCode' | 'developmentOwnRef'; value: string }[] = [];
  const collect = (f: Filter): void => {
    if (f.op === 'and' || f.op === 'or') f.filters.forEach(collect);
    else if (f.op === 'not') collect(f.filter);
    else if (f.op === 'eq' && (f.field === 'developmentCode' || f.field === 'developmentOwnRef')) {
      refs.push({ field: f.field, value: String(f.value) });
    }
  };
  collect(filter);
  if (refs.length === 0) return filter;
  const resolved = await developmentsOf(refs);
  const swap = (f: Filter): Filter => {
    switch (f.op) {
      case 'and':
      case 'or':
        return { ...f, filters: f.filters.map(swap) };
      case 'not':
        return { ...f, filter: swap(f.filter) };
      case 'eq': {
        if (f.field !== 'developmentCode' && f.field !== 'developmentOwnRef') return f;
        const ids = resolved.get(refKey(f.field, String(f.value))) ?? [];
        return { op: 'in', field: 'developmentId', values: ids.length > 0 ? ids : [NO_DEVELOPMENT] };
      }
      default:
        return f;
    }
  };
  return swap(filter);
}

async function engineSearch(
  engine: SearchEngine,
  site: PublicSearchSite,
  q: Parsed,
  siteFilter: Filter,
  offset: number,
): Promise<PublicListingSearchResult> {
  const filter = await engineFilter(siteFilter);
  const def = listingsIndex(listingsIndexUid());
  // A site showing network documents never matches free text against references (the owner's own would find a
  // network document, S7-02): a one-word text is also looked up as a reference, by filter, beside the text query.
  const labelled = whiteLabelled(site);
  // Only the fields the index holds: a request must never be able to make the engine reject the query.
  const searchOn = [
    ...(labelled ? [] : ['ref']),
    `title_${q.locale}`,
    `place_${q.locale}`,
    `description_${q.locale}`,
  ].filter((f) => def.searchable.includes(f));
  const limit = Math.min(q.limit, SEARCH_RESULT_CAP - offset);
  // Until the white-labelled reindex is done (S7-F5), free text matches the site's own documents only.
  const ownOnlyText = labelled && q.text !== undefined && !settings.networkFreeText;
  const own = site.ownerAgencyIds ?? [];
  const textFilter: Filter | null = !ownOnlyText
    ? filter
    : own.length > 0
      ? { op: 'and', filters: [filter, { op: 'in', field: 'ownerAgencyId', values: [...own] }] }
      : null;
  const query = (text: string | undefined, f: Filter, facets: string[], max: number) =>
    deadline(
      engine.search(def, {
        text,
        searchOn,
        locale: q.locale,
        filter: f,
        facets,
        sort: [SORTS[q.sort]],
        limit: max,
        offset,
        timeoutMs: settings.engineTimeoutMs,
      }),
      settings.engineTimeoutMs,
    );
  const byRef =
    labelled && offset === 0 && q.text !== undefined && REF_LIKE.test(q.text) ? refFilter(site, q.text) : null;
  const [answer, refAnswer] = await Promise.all([
    textFilter
      ? query(q.text, textFilter, q.facets, limit)
      : { ids: [], total: 0, facets: {} as Awaited<ReturnType<SearchEngine['search']>>['facets'] },
    // No facets, a few hits: a reference names one listing (rarely a few, e.g. a unit reference in two developments).
    byRef ? query(undefined, { op: 'and', filters: [filter, byRef] }, [], Math.min(limit, REF_LOOKUP_LIMIT)) : null,
  ]);
  // A reference that matches is the answer (one page: a reference names one listing, rarely a few).
  if (refAnswer && refAnswer.ids.length > 0) {
    return {
      ids: refAnswer.ids,
      total: Math.min(refAnswer.total, SEARCH_RESULT_CAP),
      facets: refAnswer.facets,
      nextCursor: null,
      backend: 'engine',
    };
  }
  const total = Math.min(answer.total, SEARCH_RESULT_CAP);
  const next = offset + answer.ids.length;
  return {
    ids: answer.ids,
    total,
    facets: answer.facets,
    nextCursor: answer.ids.length === limit && next < total ? encode({ s: q.sort, o: next }) : null,
    backend: 'engine',
  };
}

/**
 * The fallback's query: the site's filter and — with a text — the reference it may name (`refFilter`; the fallback
 * matches no other text). Null: the text can match no document here.
 */
function fallbackQuery(
  site: Pick<PublicSearchSite, 'ownerAgencyIds' | 'networkOf' | 'networkRefPrefix'>,
  q: Parsed,
  filter: Filter,
  cursor: CursorState | undefined,
): repo.FallbackQuery | null {
  const byRef = q.text === undefined ? undefined : refFilter(site, q.text);
  if (byRef === null) return null;
  return {
    filter: byRef ? { op: 'and', filters: [filter, byRef] } : filter,
    sort: SORTS[q.sort],
    limit: q.limit,
    // An engine cursor (the engine went away mid-pagination) has no position here: the first keyset page (S6-F2).
    after: cursor && 'p' in cursor ? { phase: cursor.p, value: cursor.v, id: cursor.i } : undefined,
    countCap: FALLBACK_COUNT_CAP,
  };
}

/**
 * A public read for this site's inventory (S7-F10): `app_public`, read-only, with the site's minimum commission set on
 * the transaction (folded into BEGIN) when its filter has one — the commission view answers for that minimum only.
 * Every statement that compiles the site's filter (search fallback, details, sitemap, changes, developments) runs in
 * one of these.
 */
export function withSiteRead<T>(
  site: Pick<PublicSearchSite, 'restrict'> | null | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const minCommissionBp = site?.restrict?.minCommissionBp;
  return withPublicRead(fn, minCommissionBp === undefined ? undefined : { minCommissionBp });
}

/**
 * The fallback query a site's search compiles to, with `extra` ANDed to its filter. Module-internal: perf tests reach
 * it through `testing.ts` (`@inmolink/core/modules/search/testing`), never request paths.
 */
export function siteFallbackQuery(
  site: Pick<PublicSearchSite, 'ownerAgencyIds' | 'networkOf' | 'restrict' | 'networkRefPrefix'>,
  input: PublicListingSearch,
  extra?: Filter,
): repo.FallbackQuery | null {
  const q = PublicListingSearch.parse(input);
  const filter = publicSearchFilter(site, q);
  return fallbackQuery(site, q, extra ? { op: 'and', filters: [filter, extra] } : filter, decode(q.cursor, q.sort));
}

/** The engine's answer, or a timeout error after `ms` (`SEARCH_ENGINE_TIMEOUT_MS`, whatever the adapter does). */
function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SearchError(`search timed out after ${ms} ms`, undefined, 'timeout')), ms);
  });
  // The abandoned call may still fail later: nobody waits for it.
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function fallback(
  site: PublicSearchSite,
  q: Parsed,
  filter: Filter,
  cursor: CursorState | undefined,
  reason: 'breaker_open' | 'engine_error' | 'cursor',
): Promise<PublicListingSearchResult> {
  queries.add(1, { backend: 'fallback', reason });
  return fallbackPage(site, q, filter, cursor);
}

/** One fallback page (one statement). */
async function fallbackPage(
  site: PublicSearchSite,
  q: Parsed,
  filter: Filter,
  cursor: CursorState | undefined,
): Promise<PublicListingSearchResult> {
  // An engine cursor (the engine went away mid-pagination) restarts at the fallback's first keyset page, flagged:
  // the engine's offsets mean nothing in the fallback's order, and an SQL OFFSET would scan up to 10,000 rows per
  // request while the fallback carries all traffic (S6-F2).
  const restarted = cursor !== undefined && 'o' in cursor;
  const query = fallbackQuery(site, q, filter, cursor);
  const page = query
    ? await withSiteRead(site, (tx) => repo.fallbackSearch(tx, query))
    : { ids: [], total: 0, next: null };
  return {
    ids: page.ids,
    total: page.total,
    facets: {},
    nextCursor: page.next ? encode({ s: q.sort, p: page.next.phase, v: page.next.value, i: page.next.id }) : null,
    backend: 'fallback',
    ...(restarted ? { resultsChanged: true as const } : {}),
  };
}
