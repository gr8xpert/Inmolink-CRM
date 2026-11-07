/** presentations — public API (PATTERNS §1). The only import path for other modules and apps. */
// R2-02e: client alerts' selections (worker-only).
export {
  contactSelectionTargets,
  createAlertSelection,
  relinkAlertSelection,
  selectionLinksConfigured,
  selectionUrl,
} from './alerts';
// R2-06: window cards.
export {
  configurePresentations,
  type PresentationsConfig,
  SELECTION_TOKEN,
  selectionPath,
  selectionTokenHash,
  windowCardToken,
} from './config';
export {
  eraseAgencySelections,
  eraseContactSelections,
  subjectSelectionResponses,
  subjectSelections,
} from './erasure';
export { presentationsErrors } from './errors';
export { presentationsEvents } from './events';
export { contactLikeState, selectionContactOf } from './feedback'; // R2-02c
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
export { INTERACTION_RETENTION, pruneSelectionInteractions } from './retention';
export {
  addToDraftSelection,
  createDraftSelection,
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
export {
  renderWindowCards,
  WINDOW_CARDS_TEMPLATE_VERSION,
  WindowCardsPayload,
  windowCardsBatchHtml,
  windowCardsIdOf,
  windowCardsKey,
} from './window-cards';
export {
  getWindowCards,
  prepareWindowCards,
  requestWindowCards,
  startWindowCards,
} from './window-cards-service';
export { windowCardsHtml, windowCardTemplate } from './window-cards-templates';
// Never export repo or schema.
