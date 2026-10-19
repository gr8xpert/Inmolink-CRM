/** quality — public API (PATTERNS §1). The only import path for other modules and apps. */
export { qualityErrors } from './errors';
export { qualityEvents } from './events';
export {
  enqueueRecompute,
  enqueueRecomputes,
  QUALITY_DEBOUNCE_MS,
  QUALITY_PENDING_RECHECKS,
  qualityJobs,
  requestQualityRun,
} from './jobs';
export { CLIENT_MODE_ALLOWED, can } from './policy';
export { type QualityFacts, type QualityResult, scoreListing } from './score';
export {
  type BatchRecomputeResult,
  drainQualityQueue,
  getListingQuality,
  QUALITY_BATCH,
  type QualityDrainResult,
  recomputeListingQuality,
  recomputeListingsQuality,
} from './service';
export {
  registerQualitySubscriptions,
  SCORE_IGNORED_FIELDS,
  scoreMayChange,
  unregisterQualitySubscriptions,
} from './subscriptions';
// Never export repo or schema.
