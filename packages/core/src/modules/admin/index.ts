/** admin — public API (PATTERNS §1). The only import path for other modules and apps. */

export { type AdminConfig, adminConfig, configureAdmin } from './config';
export { adminErrors } from './errors';
export { adminEvents } from './events';
export { adminJobs, MAX_RECOVERIES, OPERATION_STALE_MS, type OperationRunResult, runStaffOperation } from './jobs';
export { type AdminAction, canStaff } from './policy';
export {
  REPLAY_REFUSED_PREFIXES,
  REPLAY_REFUSED_TYPES,
  REPLAY_SAFE_TYPES,
  type ReplayClass,
  replayClass,
} from './replay-policy';
export {
  cancelOperation,
  getAiSpend,
  getOperation,
  getQueueHealth,
  grantPlan,
  listAgencyBilling,
  listFeatureFlags,
  listOperations,
  revokePlanGrant,
  type StaffCtxRunner,
  setFeatureFlag,
  setPriceLock,
  startOperation,
} from './service';
export { registerAdminSubscriptions, unregisterAdminSubscriptions } from './subscriptions';
// Never export repo or schema.
