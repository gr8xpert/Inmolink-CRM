/** mls — public API (PATTERNS §1). The only import path for other modules and apps. */

export { onRehashPendingAlert } from './alerts';
export {
  CLOSED_VIEWING_STATUSES,
  type DealChatContext,
  dealChatContext,
  dealCounterpart,
  type ViewingChatContext,
  viewingChatContext,
  viewingCounterpart,
} from './chat-context';
export { applyBp, type CommissionAmounts, type CommissionTerms, commissionOf } from './commission';
export { configureMls, type MlsConfig, REGISTRATION_CLAIM_DAYS, VIEWING_REQUEST_EXPIRY_DAYS } from './config';
export {
  DEAL_DOCUMENTS_PREFIX,
  dealDocumentKey,
  listDealDocuments,
  openDealDocument,
  removeDealDocument,
  uploadDealDocument,
} from './deal-documents';
export { dealLink, notifyDealChange } from './deal-notices';
export { createDealTask } from './deal-tasks';
export {
  advanceDeal,
  confirmDeal,
  fallThroughDeal,
  getDeal,
  getStaffDeal,
  listDeals,
  mediateDeal,
  openDeal,
  setDealPrice,
  withdrawDealConfirmation,
} from './deals';
export {
  ERASED_CLIENT,
  eraseAgencyDealDocuments,
  eraseAgencyRegistrations,
  eraseContactRegistrations,
} from './erasure';
export { mlsErrors } from './errors';
export { mlsEvents } from './events';
export {
  type MlsSubjectPage,
  pruneExpiredRegistrations,
  subjectRegistrations,
  subjectViewings,
} from './gdpr';
export { mlsJobs } from './jobs';
export {
  agenciesToRehash,
  checkFingerprintRehash,
  FINGERPRINT_RETENTION_DAYS,
  fingerprintsPending,
  pruneExpiredFingerprints,
  REHASH_ALERT_BEFORE_MS,
  rehashAgencyFingerprints,
} from './maintenance';
export {
  CLIENT_MODE_ALLOWED,
  can,
  canStaff,
  MLS_ACTIONS,
  MLS_IMPERSONATION,
  type MlsAction,
  type StaffMlsAction,
} from './policy';
export {
  listReceivedRegistrations,
  listRegistrations,
  REGISTRATION_CONFLICT_BUDGET,
  type RegisterClientResult,
  registerClient,
  repointRegistrations,
} from './service';
export { registerMlsSubscriptions, unregisterMlsSubscriptions } from './subscriptions';
// S12-05: the terms with their PDF link (after the transaction).
export { viewingTerms } from './terms-pdf';
export {
  acceptViewing,
  cancelViewing,
  declineViewing,
  expireViewingRequests,
  getViewingRequest,
  listReceivedViewingRequests,
  listViewingRequests,
  notifyViewingChange,
  prepareViewingTermsPdf, // S12-05
  recordViewingOutcome,
  requestViewing,
  rescheduleViewing,
  viewingTermsDoc,
} from './viewings';
