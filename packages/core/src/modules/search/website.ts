/**
 * Website search (S5-04, PLAN §5.4, ADR 0005 #5): a site's filters → ids, from the search engine or, when it is down
 * or slow, from the Postgres fallback (`listing_search_docs`). Both run the same engine-neutral filter, so results
 * match; the fallback ranks more simply (the sort only), matches text against references only and has no facets.
 *
 * Timing comes from config (`websiteSearchEnv`, set at boot by `configureWebsiteSearch`; S6-F3): an engine call is
 * cut at `SEARCH_ENGINE_TIMEOUT_MS` (~100 ms); at `SEARCH_SLOW_MS` (~80 ms) without an answer the fallback starts
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
import { PublicListingSearch, type PublicListingSearchResult, type PublicSearchSort } from '@inmolink/contracts';
import { withPublicRead } from '@inmolink/db';
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
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { attributeFilters } from './filters';
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
}

export const WEBSITE_SEARCH_DEFAULTS: Readonly<WebsiteSearchSettings> = {
  engineTimeoutMs: 100,
  slowMs: 80,
  breakerFailures: 5,
  breakerFailureRatio: 0.5,
  breakerMinCalls: 20,
  breakerWindowMs: 10_000,
  breakerOpenMs: 30_000,
  hedgeMaxInFlight: 16,
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

/** Who searches: the site's inventory from its policy (S7-01) — never from the visitor — and the request. */
export interface PublicSearchSite {
  /** Listings of these owner agencies; null: every agency's PUBLIC listings (a network-wide site). */
  ownerAgencyIds: readonly string[] | null;
  /** Correlates the engine-failure logs with the request. */
  requestId: string;
}

const PublicSearchSite = z.object({
  ownerAgencyIds: z.array(z.uuid()).min(1).max(500).nullable(),
  requestId: z.string().max(200),
});

/** Engine cursor: an offset · fallback cursor: the last row's position (keyset). Both carry the sort. */
type CursorState = { s: PublicSearchSort; o: number } | { s: PublicSearchSort; p: 0 | 1; v: number | null; i: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sorts whose column is never null (no phase 1), and sorts on whole numbers (their cursor value must be one). */
const NEVER_NULL: ReadonlySet<PublicSearchSort> = new Set(['newest']);
const WHOLE: ReadonlySet<PublicSearchSort> = new Set(['newest', 'price_asc', 'price_desc', 'beds_desc']);
const MAX_SORT_VALUE = 1e15;

const encode = (c: CursorState) => Buffer.from(JSON.stringify(c)).toString('base64url');

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

/** A site's search as one engine-neutral filter: PUBLIC documents of the site's inventory only. */
export function publicSearchFilter(site: Pick<PublicSearchSite, 'ownerAgencyIds'>, q: Parsed): Filter {
  const filters: Filter[] = [
    { op: 'eq', field: 'visibility', value: 'PUBLIC' },
    { op: 'in', field: 'status', values: q.statuses },
  ];
  if (site.ownerAgencyIds) filters.push({ op: 'in', field: 'ownerAgencyId', values: [...site.ownerAgencyIds] });
  filters.push(...attributeFilters(q));
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
  if (cursor && 'p' in cursor) return fallback(q, filter, cursor, 'cursor');
  const permit = breaker.acquire();
  if (!permit) return fallback(q, filter, cursor, 'breaker_open');
  const started = performance.now();
  const engineCall = engineSearch(options.engine ?? searchEngine(), q, filter, cursor?.o ?? 0).then(
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
    return fallback(q, filter, cursor, 'engine_error');
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
      return fallback(q, filter, cursor, 'engine_error');
    }
  }
  hedging += 1;
  const backup = fallbackPage(q, filter, cursor).finally(() => {
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

async function engineSearch(
  engine: SearchEngine,
  q: Parsed,
  filter: Filter,
  offset: number,
): Promise<PublicListingSearchResult> {
  const def = listingsIndex(listingsIndexUid());
  // Only the fields the index holds: a request must never be able to make the engine reject the query.
  const searchOn = ['ref', `title_${q.locale}`, `place_${q.locale}`, `description_${q.locale}`].filter((f) =>
    def.searchable.includes(f),
  );
  const limit = Math.min(q.limit, SEARCH_RESULT_CAP - offset);
  const answer = await deadline(
    engine.search(def, {
      text: q.text,
      searchOn,
      locale: q.locale,
      filter,
      facets: q.facets,
      sort: [SORTS[q.sort]],
      limit,
      offset,
      timeoutMs: settings.engineTimeoutMs,
    }),
    settings.engineTimeoutMs,
  );
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

function fallbackQuery(q: Parsed, filter: Filter, cursor: CursorState | undefined): repo.FallbackQuery {
  return {
    filter,
    ref: q.text,
    sort: SORTS[q.sort],
    limit: q.limit,
    // An engine cursor (the engine went away mid-pagination) has no position here: the first keyset page (S6-F2).
    after: cursor && 'p' in cursor ? { phase: cursor.p, value: cursor.v, id: cursor.i } : undefined,
    countCap: FALLBACK_COUNT_CAP,
  };
}

/** The fallback's statement for a site's search: perf tests EXPLAIN it on scale data (not for request paths). */
export function publicFallbackSql(site: Pick<PublicSearchSite, 'ownerAgencyIds'>, input: PublicListingSearch): SQL {
  const q = PublicListingSearch.parse(input);
  return repo.fallbackSearchSql(fallbackQuery(q, publicSearchFilter(site, q), decode(q.cursor, q.sort)));
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
  q: Parsed,
  filter: Filter,
  cursor: CursorState | undefined,
  reason: 'breaker_open' | 'engine_error' | 'cursor',
): Promise<PublicListingSearchResult> {
  queries.add(1, { backend: 'fallback', reason });
  return fallbackPage(q, filter, cursor);
}

/** One fallback page (one statement). */
async function fallbackPage(
  q: Parsed,
  filter: Filter,
  cursor: CursorState | undefined,
): Promise<PublicListingSearchResult> {
  // An engine cursor (the engine went away mid-pagination) restarts at the fallback's first keyset page, flagged:
  // the engine's offsets mean nothing in the fallback's order, and an SQL OFFSET would scan up to 10,000 rows per
  // request while the fallback carries all traffic (S6-F2).
  const restarted = cursor !== undefined && 'o' in cursor;
  const page = await withPublicRead((tx) => repo.fallbackSearch(tx, fallbackQuery(q, filter, cursor)));
  return {
    ids: page.ids,
    total: page.total,
    facets: {},
    nextCursor: page.next ? encode({ s: q.sort, p: page.next.phase, v: page.next.value, i: page.next.id }) : null,
    backend: 'fallback',
    ...(restarted ? { resultsChanged: true as const } : {}),
  };
}
