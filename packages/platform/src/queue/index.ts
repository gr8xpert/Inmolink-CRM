/**
 * @inmolink/platform/queue — background jobs over BullMQ (PATTERNS §12, workers.md).
 *
 *   module jobs.ts — `defineJob({ name, pool, payload, jobId, group, run })`
 *   producers      — `await jobs.x.enqueue(payload, { debounceMs })` (never inside a DB transaction)
 *   apps/worker    — `registerPool('indexing', [searchJobs.reindexListing])`
 */
export { readCheckpoint, writeCheckpoint } from './checkpoint';
export { closeQueues, configureQueue, producerConnection, type QueueConfig, queueFor } from './connection';
export { type BacklogEntry, Fairness, MAX_PRIORITY } from './fairness';
export {
  defineJob,
  type EnqueueOptions,
  type EnqueueResult,
  type JobContext,
  type JobDef,
  type JobSpec,
  stableJobId,
} from './jobs';
export {
  deadLetterQueue,
  groupRetryDelay,
  isPermanent,
  type PoolHandle,
  type PoolOptions,
  queueWaitMs,
  RetryableError,
  registerPool,
  UnrecoverableError,
} from './worker';
