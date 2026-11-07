/** dedupe — public API (PATTERNS §1). The only import path for other modules and apps. */

// R2-03b: clusters (pure rules), the recluster pass (worker), the review queue and disputes (requests, staff).
export {
  type ClusterDecision,
  type ClusterNode,
  type ClusterPair,
  canonicalOrder,
  type FormedCluster,
  formClusters,
  hasConflict,
  MAX_CLUSTER_MEMBERS,
} from './clusters';
export { dedupeErrors } from './errors';
export { dedupeEvents, PAIRS_EVENT_IDS } from './events';
export { DEDUPE_SWEEP_EVERY_MS, dedupeJobs } from './jobs';
export {
  CLIENT_MODE_ALLOWED,
  can,
  canStaff,
  DEDUPE_ACTIONS,
  DEDUPE_IMPERSONATION,
  type DedupeAction,
  type StaffDedupeAction,
} from './policy';
export { MAX_COMPONENT, MAX_ROUNDS, type ReclusterResult } from './recluster';
export {
  decideDuplicateReview,
  listDuplicateClusters,
  listDuplicateDisputes,
  listDuplicateReviews,
  // R2-03c: agents' "listed by N agencies"
  listedBy,
  listStaffDuplicateDisputes,
  openDuplicateDispute,
  resolveDuplicateDispute,
} from './review';
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
  applyDispute,
  applyReview,
  BACKFILL_RUN,
  BACKFILL_WINDOW,
  backfillWindow,
  COMMON_KEY_LISTINGS,
  // R2-03c: worker form, for matching's delivery
  clusterMembersOf,
  MAX_CANDIDATES,
  MAX_PAIRS_PER_LISTING,
  type RescoreResult,
  recluster,
  rescoreListings,
  sweepWindow,
} from './service';
export { SIGNATURE_VERSION } from './signature';
export { registerDedupeSubscriptions, unregisterDedupeSubscriptions } from './subscriptions';
// Never export repo or schema.
