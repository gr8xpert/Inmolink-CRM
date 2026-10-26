/** ai-features — public API (PATTERNS §1). The only import path for other modules and apps. */
// S12-02: errors, events, jobs, policy and the AI Listing Studio.
export { aiFeaturesErrors } from './errors';
export { aiFeaturesEvents } from './events';
export {
  aiFeaturesJobs,
  DEGRADED_RETRY_DELAYS_MS,
  STUDIO_BATCH_RETENTION_DAYS,
  STUDIO_MAX_POLLS,
  STUDIO_POLL_MS,
  WHITE_LABEL_MAX_POLLS,
  WHITE_LABEL_POLL_MS,
  WHITE_LABEL_SWEEP_EVERY_MS,
  whiteLabelJobs,
} from './jobs';
export { AI_FEATURES_ACTIONS, AI_FEATURES_IMPERSONATION, CLIENT_MODE_ALLOWED, can } from './policy';
export {
  type AutoDraftResult,
  abandonListingStudioBatch,
  autoDraftListing,
  collectListingStudioBulk,
  generateListingStudio,
  LISTING_STUDIO_PROMPT,
  pruneListingStudioBatches,
  requestListingStudio,
  requestListingStudioBulk,
  STUDIO_AUTO_DRAFTS_FLAG,
  STUDIO_REPAIRS_PER_APPLY,
  type StudioOutcome,
  type StudioRequest,
  submitListingStudioBulk,
} from './studio';
export {
  allowedFigures,
  copyViolations,
  ListingCopy,
  moneyFigures,
  moneyLeaks,
  numberWordsIn,
  readingsOf,
  type StudioFacts,
  type StudioInput,
  studioFacts,
} from './studio-facts';
export {
  OWNER_CHANGE_WINDOW_MS,
  ownerChangeRun,
  queueOwnerChangeWalk,
  registerAiFeaturesSubscriptions,
  registerWhiteLabelSubscriptions,
  unregisterAiFeaturesSubscriptions,
  unregisterWhiteLabelSubscriptions,
} from './subscriptions';
// S12-03: the white-label sanitizer (its jobs and subscriptions live in jobs.ts / subscriptions.ts). S13-F17: the raw
// model call (`modelRemovals`) stays internal — callers go through `sanitizeTargetTexts` / the backfill, which check the
// agency's WHITE_LABEL toggle first.
export {
  BACKFILL_PAGE_TARGETS,
  type BackfillCollect,
  type BackfillCursor,
  type BackfillItem,
  type BackfillPageResult,
  collectWhiteLabelBackfill,
  docTexts,
  MAX_MODEL_TEXT_CHARS,
  MIN_MODEL_TEXT_CHARS,
  modelInput,
  type PreparedText,
  parseRemovals,
  prepareTexts,
  protectedNamesOf,
  removalsByText,
  type SanitizeTextsResult,
  sanitizeTargetTexts,
  shownOnNetwork,
  unescapeBlockText,
  WHITE_LABEL_BACKFILL_FEATURE,
  WHITE_LABEL_BLOCK,
  WHITE_LABEL_FEATURE,
  WHITE_LABEL_PROMPT,
  WhiteLabelRemovals,
  whiteLabelBackfillPage,
} from './white-label';
// Export service functions and DTO-facing types here as they are added. Never export repo or schema.
