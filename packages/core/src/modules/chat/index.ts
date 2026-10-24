/**
 * chat — public API (PATTERNS §1). The only import path for other modules and apps.
 *
 * S11-03 (PLAN §7 M12): `DIRECT` threads between colleagues and `VIEWING` threads between the two agencies of a
 * viewing request (each agency reads its own copy; RLS shows messages to the thread's participants only), read state,
 * live delivery over apps/realtime `/chat` (`canJoinThread` gates a socket's thread room: typing indicator), and a
 * `CHAT_MESSAGE` notification per run of unread messages (the notifications module's 5-minute e-mail digest).
 */
export { closeViewingThread, deliverMessage, pushRead, seatViewingThread } from './delivery';
export { chatErrors } from './errors';
export { chatEvents } from './events';
export { handoffLinks, WHATSAPP_SHARE_URL } from './handoff';
export { chatJobs } from './jobs';
export { CHAT_ACTIONS, CHAT_IMPERSONATION, type ChatAction, CLIENT_MODE_ALLOWED, can } from './policy';
export {
  canJoinThread,
  createDirectThread,
  getThread,
  listMessages,
  listThreads,
  markThreadRead,
  openViewingThread,
  sendMessage,
  threadLink,
} from './service';
export { registerChatSubscriptions, unregisterChatSubscriptions } from './subscriptions';
