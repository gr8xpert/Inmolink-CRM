/** crm — public API (PATTERNS §1). The only import path for other modules and apps. */
export { crmErrors } from './errors';
export { crmEvents } from './events';
export {
  authorizeContactImport,
  getContactImport,
  listContactImports,
  startContactImport,
  uploadContactImport,
} from './import';
export { crmJobs } from './jobs';
export { CLIENT_MODE_ALLOWED, CRM_ACTIONS, CRM_IMPERSONATION, type CrmAction, can } from './policy';
export {
  addContactNote,
  type CreateContactResult,
  createContact,
  getContact,
  listContactNotes,
  listContacts,
  lookupContacts,
  mergeContacts,
  updateContact,
} from './service';
export { registerCrmSubscriptions, unregisterCrmSubscriptions } from './subscriptions';
