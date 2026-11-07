/** dedupe — public API (PATTERNS §1). The only import path for other modules and apps. */
export { dedupeErrors } from './errors';
export { dedupeEvents } from './events';
export { DEDUPE_SWEEP_EVERY_MS, dedupeJobs } from './jobs';
export {
  AUTO_CLUSTER_SCORE,
  PAIR_STORE_MIN,
  type PairScore,
  type PairSignals,
  REVIEW_SCORE,
  SCORER_VERSION,
  scorePair,
  WEIGHTS,
} from './scoring';
export {
  BACKFILL_RUN,
  BACKFILL_WINDOW,
  backfillWindow,
  COMMON_KEY_LISTINGS,
  MAX_CANDIDATES,
  MAX_PAIRS_PER_LISTING,
  type RescoreResult,
  rescoreListings,
  sweepWindow,
} from './service';
export { SIGNATURE_VERSION } from './signature';
export { registerDedupeSubscriptions, unregisterDedupeSubscriptions } from './subscriptions';
// Never export repo or schema.
