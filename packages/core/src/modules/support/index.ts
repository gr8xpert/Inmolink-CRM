/** support — public API (PATTERNS §1). The only import path for other modules and apps. S13-05: support tickets. */
export { configureSupport, type SupportConfig, supportConfig } from './config';
export { supportErrors } from './errors';
export { supportEvents } from './events';
export { supportJobs } from './jobs';
export {
  CLIENT_MODE_ALLOWED,
  can,
  canStaff,
  type StaffSupportAction,
  type SupportAction,
} from './policy';
export {
  ATTACHMENT_URL_TTL_SECONDS,
  createTicket,
  getAttachmentUrl,
  getStaffAttachmentUrl,
  getStaffTicket,
  getTicket,
  listQueue,
  listTickets,
  postMessage,
  postStaffMessage,
  resolveTicket,
  updateStaffTicket,
  uploadAttachment,
} from './service';
export { registerSupportSubscriptions, unregisterSupportSubscriptions } from './subscriptions';
// Never export repo or schema.
