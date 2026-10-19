/**
 * Website search (S5-04, PLAN §5.4, ADR 0005 #5): a site's filters → ids, from the search engine or, when it is down
 * or slow, from the Postgres fallback (`listing_search_docs`). Both run the same engine-neutral filter, so results
 * match; the fallback ranks more simply (the sort only), matches text against references only and has no facets.
 *
 * A circuit breaker per process decides: an engine call that fails, times out (`SEARCH_ENGINE_TIMEOUT_MS`) or answers
 * slower than `SEARCH_SLOW_MS` counts; `SEARCH_BREAKER_FAILURES` in a row switch every request to the fallback for
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

/** Longest wait for one engine query before the request is answered by the fallback. */
export const SEARCH_ENGINE_TIMEOUT_MS = 300;
/** An engine answer slower than this counts against the engine (it still serves the request). */
export const SEARCH_SLOW_MS = 250;
/** Failed or slow engine queries in a row that switch to the fallback. */
export const SEARCH_BREAKER_FAILURES = 5;
/** How long the fallback serves alone before one request probes the engine again. */
export const SEARCH_BREAKER_OPEN_MS = 30_000;
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
    failureThreshold: SEARCH_BREAKER_FAILURES,
    openMs: SEARCH_BREAKER_OPEN_MS,
    slowMs: SEARCH_SLOW_MS,
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
  try {
    const result = await engineSearch(options.engine ?? searchEngine(), q, filter, cursor?.o ?? 0);
    permit.success(performance.now() - started);
    queries.add(1, { backend: 'engine' });
    return result;
  } catch (err) {
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
    return fallback(q, filter, cursor, 'engine_error');
  }
}

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
      timeoutMs: SEARCH_ENGINE_TIMEOUT_MS,
    }),
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

/** The engine's answer, or a timeout error after `SEARCH_ENGINE_TIMEOUT_MS` (whatever the adapter does). */
function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SearchError(`search timed out after ${SEARCH_ENGINE_TIMEOUT_MS} ms`, undefined, 'timeout')),
      SEARCH_ENGINE_TIMEOUT_MS,
    );
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
