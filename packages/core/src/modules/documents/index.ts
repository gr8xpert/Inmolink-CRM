/**
 * documents — PDF brochures, portfolios and accepted viewing terms (S12-05, PLAN §7 M13) — public API (PATTERNS §1).
 * Rendered by the `pdf` worker pool through `@inmolink/platform/pdf`, stored in the private bucket, handed out as short
 * signed links. Selections (presentations, S12-04) make a selection's PDF with `requestPortfolio`;
 * mls (S11-02) queues the accepted-terms PDF with `queueViewingTermsPdf` and links it with `viewingTermsPdfUrl`.
 * R2-05a: the forms library (`form_documents`, its one table) — mls makes a deal's collaboration agreement with
 * `createCollaborationAgreement`; compliance erases an agency's forms with `eraseAgencyForms`.
 */
export {
  configureDocuments,
  DOCUMENT_ID_WINDOW_MS,
  DOCUMENT_LINK_SECONDS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_RENDERS_PER_AGENCY,
  DOCUMENT_TEMPLATE_VERSION,
  documentKey,
  viewingTermsKey,
} from './config';
export { documentsErrors } from './errors';
export { documentsEvents } from './events';
export {
  type CollaborationDeal,
  createCollaborationAgreement,
  createFormDocument,
  eraseAgencyForms,
  eraseContactForms,
  FORM_DOCUMENTS_PREFIX,
  FORMS_FLAG,
  formDocumentHtml,
  formDocumentKey,
  getFormDocument,
  listFormDocuments,
  renderFormDocument,
  repointContactForms,
} from './forms';
export { FORM_TEMPLATE_VERSION, FormData } from './forms-data';
// R2-05a: the SUBJECT data export's forms table (compliance worker).
export { subjectForms } from './forms-repo';
export { FORM_CLAUSES, FORM_SIGNERS, formHtml } from './forms-templates';
export { documentsJobs } from './jobs';
export { ListingsDocumentPayload, ViewingTermsPayload } from './payloads';
export { CLIENT_MODE_ALLOWED, can, DOCUMENTS_IMPERSONATION } from './policy';
export {
  listingsDocumentHtml,
  loadDocumentListings,
  renderListingsDocument,
  renderViewingTermsDocument,
  viewingTermsPdfExists,
  viewingTermsPdfUrl,
} from './render';
export {
  documentIdOf,
  enqueueAfresh,
  getDocument,
  type PreparedDocument,
  prepareBrochure,
  preparePortfolio,
  queueViewingTermsPdf,
  requestBrochure,
  requestPortfolio,
  startDocument,
} from './service';
export { registerDocumentsSubscriptions, unregisterDocumentsSubscriptions } from './subscriptions';
export {
  brochureHtml,
  type DocFormat,
  docFormat,
  type ListingsDocInput,
  portfolioHtml,
  type ViewingTermsDocInput,
  viewingTermsHtml,
} from './templates';
