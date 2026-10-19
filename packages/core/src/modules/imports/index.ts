/** imports — public API (PATTERNS §1). The only import path for other modules and apps. */
export { configureImports, defaultWithdrawAfterMissedRuns, FEED_FETCH, type ImportsConfig, RUNS } from './config';
export {
  type ConnectorContext,
  connectorKeys,
  credentialHeaders,
  credentialUrl,
  type FeedConnector,
  FeedHttpStatusError,
  type FeedItemProblem,
  FeedMappingError,
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
export { kyeroConnector } from './kyero/connector';
export { KYERO_V3_FIELDS, renderCoverageReport as renderKyeroCoverageReport } from './kyero/coverage';
export {
  countOnlySink,
  FeedNoOwnerError,
  type FeedSink,
  listingSink,
  type RunLoader,
  type SinkCounts,
  type SinkRun,
  sourceOf,
} from './load';
export {
  createMappingProfile,
  dryRunMapping,
  getMappingProfile,
  listMappingProfiles,
  previewMapping,
  sampleFromUpload,
  sampleFromUrl,
  updateMappingProfile,
} from './mapper';
export type { ItemError, PendingBatch, PipelineTotals, ValidItem } from './pipeline';
export { CLIENT_MODE_ALLOWED, can, IMPORTS_ACTIONS, IMPORTS_IMPERSONATION, type ImportsAction } from './policy';
export { resalesConnector } from './resales/connector';
export { classifyRunError, executeRun, LeaseLostError, type RunOutcome } from './runner';
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
export { sheetKey, sheetMappedConnector } from './sheet/connector';
export { startSheetImport, uploadSheet } from './sheet/service';
export { registerImportsSubscriptions } from './subscriptions';
export { xmlMappedConnector } from './xml-mapped/connector';
// Never export repo or schema from index.
