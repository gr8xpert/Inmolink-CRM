/** imports — public API (PATTERNS §1). The only import path for other modules and apps. */
export { configureImports, FEED_FETCH, type ImportsConfig, RUNS } from './config';
export {
  type ConnectorContext,
  connectorKeys,
  credentialHeaders,
  type FeedConnector,
  FeedHttpStatusError,
  type FeedItemProblem,
  type FeedRecord,
  type FeedSource,
  getConnector,
  httpSource,
  type MapResult,
  registerConnector,
  XML_CONTENT_TYPES,
  xmlRecords,
} from './connectors';
export { importsErrors } from './errors';
export { importsEvents } from './events';
export { importsJobs } from './jobs';
export type { ItemError, PendingBatch, PipelineTotals, ValidItem } from './pipeline';
export { CLIENT_MODE_ALLOWED, can, IMPORTS_ACTIONS, IMPORTS_IMPERSONATION, type ImportsAction } from './policy';
export { classifyRunError, countOnlySink, executeRun, type FeedSink, LeaseLostError, type RunOutcome } from './runner';
export {
  createFeedConnection,
  deleteFeedConnection,
  getFeedConnection,
  getFeedRun,
  listFeedConnections,
  listFeedItemErrors,
  listFeedRuns,
  requestFeedRun,
  updateFeedConnection,
} from './service';
export { registerImportsSubscriptions } from './subscriptions';
// Never export repo or schema from index.
