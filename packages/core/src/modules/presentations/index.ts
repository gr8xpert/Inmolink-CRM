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
export { CLIENT_MODE_ALLOWED, can, type PresentationsAction } from './policy';
export {
  checkSelectionLimits,
  interactionOf,
  presentSelection,
  recordSelectionInteraction,
  SELECTION_PAGE_LIMITS,
  type SelectionDocRow,
  type SelectionInteraction,
  type SelectionPageItem,
  type SelectionPageModel,
  selectionPage,
} from './public';
export {
  createSelection,
  getSelection,
  listSelectionInteractions,
  listSelections,
  rotateSelectionLink,
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
