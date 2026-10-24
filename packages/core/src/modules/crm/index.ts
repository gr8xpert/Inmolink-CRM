/** crm — public API (PATTERNS §1). The only import path for other modules and apps. */
export {
  listActivities,
  logActivity,
  NOTE_EXCERPT_CHARS,
  type RecordedActivity,
  recordActivity,
} from './activities';
export {
  CALENDAR_FEED_MAX_AGE_S,
  type CalendarFeedFile,
  calendarFeed,
  calendarFeedPath,
  configureCalendarFeeds,
  createCalendarEvent,
  forgetListingEvents,
  getCalendarEvent,
  getCalendarFeed,
  listCalendarEvents,
  revokeCalendarFeed,
  rotateCalendarFeed,
  sendEventReminder,
  sweepEventReminders,
  updateCalendarEvent,
} from './calendar';
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
export {
  createLead,
  getLead,
  getLeadRouting,
  isInboundLeadPromoted,
  listLeadIntroductions,
  listLeads,
  promoteInboundLead,
  updateLead,
  updateLeadRouting,
} from './leads';
export {
  createPipelineStage,
  getPipelineBoard,
  getPipelineReport,
  listLeadStageHistory,
  listPipelineStages,
  listStageLeads,
  moveLead,
  reorderPipelineStages,
  updatePipelineStage,
} from './pipeline';
export { CLIENT_MODE_ALLOWED, CRM_ACTIONS, CRM_IMPERSONATION, type CrmAction, can } from './policy';
export {
  convertProspect,
  createProspect,
  deleteProspect,
  forgetListingProspects,
  getProspect,
  getProspectBoard,
  listProspectFollowUps,
  listProspects,
  listStageProspects,
  moveProspect,
  repointSellerListings,
  updateProspect,
} from './prospects';
export { getResponseTimeKpi, recordAutoAck } from './response';
export { type Route, type RouteInput, routeLead } from './routing';
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
export {
  createTask,
  deleteTask,
  forgetListingTasks,
  getTask,
  listTasks,
  REMINDER_GRACE_MS,
  sendTaskReminder,
  sweepTaskReminders,
  updateTask,
} from './tasks';
