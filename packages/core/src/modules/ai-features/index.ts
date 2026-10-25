/** ai-features — public API (PATTERNS §1). The only import path for other modules and apps. */
// S12-03: the white-label sanitizer's jobs and subscriptions (owned by the S12-03 lane).
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
export { registerWhiteLabelSubscriptions, unregisterWhiteLabelSubscriptions, whiteLabelJobs } from './white-label-jobs';
// Export service functions and DTO-facing types here as they are added. Never export repo or schema.
