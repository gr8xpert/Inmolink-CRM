/** search — public API (PATTERNS §1). The only import path for other modules and apps. */
export { type BuiltDoc, etagOf, pickText } from './build';
export { searchErrors } from './errors';
export { searchEvents } from './events';
export {
  buildIndexDoc,
  INDEXED_DESCRIPTION_CHARS,
  type IndexSourceRow,
  type IndexVisibility,
  LISTINGS_INDEX_UID,
  type ListingIndexDoc,
  listingsIndex,
} from './index-doc';
export {
  checkIndexDrift,
  configureSearchIndex,
  DRIFT_SAMPLE,
  type DriftReport,
  INDEX_SYNC_BATCH,
  INDEX_SYNC_LEASE_MS,
  listingsIndexUid,
  REPAIR_PAGE,
  type RepairResult,
  repairIndex,
  type SyncResult,
  syncIndex,
} from './indexer';
export {
  INDEX_SYNC_THROTTLE_MS,
  queueAgencyReadModels,
  queueReadModel,
  queueReadModels,
  READ_MODEL_DEBOUNCE_MS,
  READ_MODEL_PENDING_RECHECKS,
  requestIndexSync,
  requestReadModelBuild,
  searchJobs,
} from './jobs';
export {
  type CommissionTerms,
  configureNetworkSearch,
  GIVE_TO_GET_DEFAULTS,
  giveToGetGate,
  NETWORK_ENGINE_TIMEOUT_MS,
  networkCommission,
  searchNetwork,
} from './network';
export { CLIENT_MODE_ALLOWED, can } from './policy';
export {
  AGENCY_QUEUE_PAGE,
  countReadModelTargets,
  type DrainOptions,
  type DrainResult,
  drainReadModelQueue,
  ensureListingsIndex,
  type FullRebuildOptions,
  type FullRebuildProgress,
  indexDocsFor,
  MAX_LOCKS_IN_FLIGHT,
  queueAgencyReadModelChanges,
  READ_MODEL_BATCH,
  type ReadModelKind,
  type RebuildResult,
  readModelDocs,
  rebuildAllReadModels,
  rebuildDevelopmentReadModels,
  rebuildListingReadModels,
  rebuildReadModels,
  rebuildUnitReadModels,
} from './service';
export {
  DEVELOPMENT_IGNORED_FIELDS,
  registerSearchSubscriptions,
  unregisterSearchSubscriptions,
} from './subscriptions';
export {
  configureWebsiteSearch,
  FALLBACK_COUNT_CAP,
  type PublicSearchSite,
  publicFallbackSql,
  publicSearchFilter,
  resetSearchBreaker,
  SEARCH_RESULT_CAP,
  type SiteRestriction,
  searchBreakerState,
  searchPublicListings,
  WEBSITE_SEARCH_DEFAULTS,
  type WebsiteSearchSettings,
  websiteSearchSettings,
} from './website';
// Never export repo or schema.
