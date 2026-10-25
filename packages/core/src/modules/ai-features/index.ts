/** ai-features — public API (PATTERNS §1). The only import path for other modules and apps. */
// S12-02: errors, events, jobs, policy and the AI Listing Studio.
export { aiFeaturesErrors } from './errors';
export { aiFeaturesEvents } from './events';
export {
  aiFeaturesJobs,
  STUDIO_BATCH_RETENTION_DAYS,
  STUDIO_MAX_POLLS,
  STUDIO_POLL_MS,
  whiteLabelJobs,
} from './jobs';
export { AI_FEATURES_ACTIONS, AI_FEATURES_IMPERSONATION, CLIENT_MODE_ALLOWED, can } from './policy';
export {
  abandonListingStudioBatch,
  collectListingStudioBulk,
  generateListingStudio,
  LISTING_STUDIO_PROMPT,
  pruneListingStudioBatches,
  requestListingStudio,
  requestListingStudioBulk,
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
  registerAiFeaturesSubscriptions,
  registerWhiteLabelSubscriptions,
  unregisterAiFeaturesSubscriptions,
  unregisterWhiteLabelSubscriptions,
} from './subscriptions';
// S12-03: the white-label sanitizer (its jobs and subscriptions live in jobs.ts / subscriptions.ts).
export {
  docTexts,
  MAX_MODEL_TEXT_CHARS,
  MIN_MODEL_TEXT_CHARS,
  modelInput,
  modelRemovals,
  type PreparedText,
  prepareTexts,
  protectedNamesOf,
  removalsByText,
  type SanitizeTextsResult,
  sanitizeTargetTexts,
  shownOnNetwork,
  unescapeBlockText,
  WHITE_LABEL_BLOCK,
  WHITE_LABEL_FEATURE,
  WHITE_LABEL_PROMPT,
  WhiteLabelRemovals,
} from './white-label';
// Export service functions and DTO-facing types here as they are added. Never export repo or schema.
