/**
 * notifications — public API (PATTERNS §1). The only import path for other modules and apps.
 *
 * ## Raising a notification (for S11-02 viewing requests, S11-03 chat, S11-05 network board, CRM)
 *
 * 1. Add the type to `NOTIFICATION_TYPES` (`@inmolink/contracts`) and its text to
 *    `packages/i18n/messages/{en,es}/notifications.json` (`types.<TYPE>` + `typeLabels.<TYPE>`); no migration.
 * 2. Same agency, inside your use case's transaction — the notification exists if and only if your change commits:
 *    ```ts
 *    await notifications.notify(ctx, {
 *      type: 'CHAT_MESSAGE',
 *      userIds: [memberId],                       // ≤ 100; the actor and non-members are dropped
 *      params: { actor: 'Ana', subject: 'Villa INL-7KQ2M3P' }, // display values for the message, never PII
 *      link: `/chat/${threadId}`,                 // a path inside the dashboard
 *    });
 *    ```
 * 3. Across agencies (agency B's action notifies agency A's members): RLS keeps a request from writing another
 *    agency's rows, so emit your own outbox event, subscribe to it, and in your job call
 *    `notifications.raiseNotifications(tx, { agencyId: A, type, userIds, params, link, sourceKey: meta.eventId,
 *    at: meta.createdAt })` inside `withSystem(reason, tx => …)` — `sourceKey` + `at` make a retried job idempotent.
 *
 * Everything after that is this module's: the recipient's preference (type off → no row, no push, no e-mail),
 * the live push to their sockets (apps/realtime `/notifications`, event `notification`, `NotificationPush`),
 * the unread count and the 5-minute e-mail digest of what stays unread.
 */
export { DIGEST_LISTED, renderDigest } from './digest-email';
export { notificationsErrors } from './errors';
export { notificationsEvents } from './events';
export { notificationsJobs } from './jobs';
export {
  CLIENT_MODE_ALLOWED,
  can,
  NOTIFICATIONS_ACTIONS,
  NOTIFICATIONS_IMPERSONATION,
  type NotificationsAction,
} from './policy';
export {
  DIGEST_BATCH,
  DIGEST_DELAY_MS,
  type DigestResult,
  getNotificationPreferences,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  NotifyInput,
  type NotifyResult,
  notify,
  pushNotifications,
  raiseNotifications,
  sendDigest,
  updateNotificationPreference,
} from './service';
export { registerNotificationsSubscriptions, unregisterNotificationsSubscriptions } from './subscriptions';
