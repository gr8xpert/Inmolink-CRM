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
  enqueueReadModel,
  READ_MODEL_DEBOUNCE_MS,
  READ_MODEL_PENDING_RECHECKS,
  searchJobs,
} from './jobs';
export { CLIENT_MODE_ALLOWED, can } from './policy';
export {
  countReadModelTargets,
  ensureListingsIndex,
  type FullRebuildOptions,
  type FullRebuildProgress,
  indexDocsFor,
  MAX_LOCKS_IN_FLIGHT,
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
// Never export repo or schema.
