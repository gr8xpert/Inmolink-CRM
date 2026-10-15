/** quality — public API (PATTERNS §1). The only import path for other modules and apps. */
export { qualityErrors } from './errors';
export { qualityEvents } from './events';
export { enqueueRecompute, QUALITY_DEBOUNCE_MS, QUALITY_PENDING_RECHECKS, qualityJobs } from './jobs';
export { CLIENT_MODE_ALLOWED, can } from './policy';
export { type QualityFacts, type QualityResult, scoreListing } from './score';
export { getListingQuality, recomputeListingQuality } from './service';
export { registerQualitySubscriptions, unregisterQualitySubscriptions } from './subscriptions';
// Never export repo or schema.
