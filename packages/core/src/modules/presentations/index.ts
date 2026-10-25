/** presentations — public API (PATTERNS §1). The only import path for other modules and apps. */
export {
  configurePresentations,
  type PresentationsConfig,
  SELECTION_TOKEN,
  selectionPath,
  selectionTokenHash,
} from './config';
export { presentationsErrors } from './errors';
export { presentationsEvents } from './events';
export { presentationsJobs } from './jobs';
export {
  CLIENT_MODE_ALLOWED,
  can,
  PRESENTATIONS_ACTIONS,
  PRESENTATIONS_IMPERSONATION,
  type PresentationsAction,
} from './policy';
export {
  checkSelectionLimits,
  interactionOf,
  presentSelection,
  recordSelectionInteraction,
  recordSelectionPageView,
  SELECTION_PAGE_LIMITS,
  type SelectionDocRow,
  type SelectionInteraction,
  type SelectionPageItem,
  type SelectionPageModel,
  selectionPage,
  VIEW_WINDOW_SECONDS,
} from './public';
export {
  createSelection,
  getSelection,
  listSelectionInteractions,
  listSelections,
  rotateSelectionLink,
  selectionPdf, // S12-05
  shareLinks,
  statusOf,
  updateSelection,
} from './service';
export {
  registerPresentationsSubscriptions,
  selectionTimelineActivity,
  unregisterPresentationsSubscriptions,
} from './subscriptions';
// Never export repo or schema.
