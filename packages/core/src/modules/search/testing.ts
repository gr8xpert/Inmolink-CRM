import type { PublicListingSearch } from '@inmolink/contracts';
import type { Filter } from '@inmolink/platform/search';
import type { SQL } from 'drizzle-orm';
import * as repo from './repo';
import { type PublicSearchSite, siteFallbackQuery } from './website';

/**
 * Perf-test entry point of the search module (`@inmolink/core/modules/search/testing`): the website fallback's SQL for
 * EXPLAIN on scale data. Not re-exported from `index.ts`; the boundaries check keeps it out of non-test code.
 */

type Site = Pick<PublicSearchSite, 'ownerAgencyIds' | 'networkOf' | 'restrict' | 'networkRefPrefix'>;

/** A condition ANDed to the site's filter that the public contract has no parameter for yet. */
export interface PublicFallbackSqlOptions {
  /** e.g. a plot band (S7-F11: the fallback compiles every filterable field of the index, `plotM2` included). */
  extra?: Filter;
}

/** The fallback's statement for a site's search. */
export function publicFallbackSql(
  site: Site,
  input: PublicListingSearch,
  options: PublicFallbackSqlOptions = {},
): SQL | null {
  const query = siteFallbackQuery(site, input, options.extra);
  return query ? repo.fallbackSearchSql(query) : null;
}

/**
 * The fallback's filter alone, as a condition on `listing_search_docs` (S7-F11): perf tests compare the planner's
 * estimate of its rows with the real count.
 */
export function publicFallbackCondition(
  site: Site,
  input: PublicListingSearch,
  options: PublicFallbackSqlOptions = {},
): SQL | null {
  const query = siteFallbackQuery(site, input, options.extra);
  return query ? repo.fallbackCondition(query.filter) : null;
}

/**
 * Whether this search's filter bounds its sort column (S7-F9, `repo.requiresValue`): the fallback then has no null
 * phase to read. Perf tests pick their plan expectation with it.
 */
export function publicFallbackBoundsSort(
  site: Site,
  input: PublicListingSearch,
  options: PublicFallbackSqlOptions = {},
): boolean {
  const query = siteFallbackQuery(site, input, options.extra);
  return query !== null && repo.requiresValue(query.filter, query.sort.field);
}
