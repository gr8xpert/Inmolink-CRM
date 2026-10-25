/**
 * matching — public API (PATTERNS §1). The only import path for other modules and apps.
 *
 * S5-06 (PLAN §7 M9): an agent's saved searches (`listSavedSearches`, `createSavedSearch`, `updateSavedSearch`,
 * `deleteSavedSearch`) and their alerts — a listing new on the market, its price dropped, back on the market — raised
 * from the read models' `search.listings.changed` events (`matchListings`, one alert per saved search, listing and
 * change) and delivered by the notifications module (`SAVED_SEARCH_ALERT`: in-app, live push, e-mail summary), at once
 * in a short (5-minute) or daily digest (`sendAlerts`).
 */
export {
  ANY,
  type CurrentListing,
  GONE,
  listingKeys,
  NEW_LISTING_WINDOW_MS,
  type SeenState,
  searchKeys,
  type Transition,
  transitionOf,
} from './alerts';
export { matchingErrors } from './errors';
export { matchingEvents } from './events';
export { matchingJobs, STALE_INSTANT_MS, SWEEP_SPREAD_MS, sweepDelayOf } from './jobs';
export {
  CLIENT_MODE_ALLOWED,
  can,
  MATCHING_ACTIONS,
  MATCHING_IMPERSONATION,
  type MatchingAction,
} from './policy';
export {
  ALERT_RETENTION_DAYS,
  BACKFILL_BATCH,
  backfillListingStates,
  createSavedSearch,
  deleteSavedSearch,
  GONE_RETENTION_DAYS,
  INSTANT_WINDOW_MS,
  listSavedSearches,
  type MatchResult,
  matchListings,
  pendingAlertAgencies,
  pruneMatching,
  rekeyAgency,
  SAVED_SEARCHES_LINK,
  SEND_CLAIM,
  SWEEP_PAGE,
  savedSearchAgencies,
  sendAlerts,
  updateSavedSearch,
} from './service';
export { registerMatchingSubscriptions, unregisterMatchingSubscriptions } from './subscriptions';
// Never export repo or schema.
