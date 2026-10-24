/**
 * network — public API (PATTERNS §1). The only import path for other modules and apps.
 *
 * S11-05, the network board (AMS, PLAN §3 #24, §7 M11): posts (buyer requests, property offers, distressed sales,
 * developer announcements) with structured criteria in the search vocabulary and an expiry, read by the verified
 * agencies of the network while open; members' subscriptions with filters (`NETWORK_POST` for matching posts of other
 * agencies); replies open a `NETWORK` chat thread with the poster (`chat.replyInNetworkThread`); a buyer request is
 * matched against the other agencies' listings over the search engine (`NETWORK_MATCH`, once per agency).
 */
export { networkErrors } from './errors';
export { networkEvents } from './events';
export { networkJobs } from './jobs';
export {
  closeExpiredPosts,
  EXPIRY_BATCH,
  MATCH_AGENCY_BATCH,
  matchBuyerRequest,
  matchSourceKey,
  notifySubscribers,
  postLink,
  SUBSCRIBER_AGENCY_BATCH,
} from './matching';
export { CLIENT_MODE_ALLOWED, can, NETWORK_ACTIONS, NETWORK_IMPERSONATION, type NetworkAction } from './policy';
export {
  closePost,
  createPost,
  createSubscription,
  deleteSubscription,
  getPost,
  joinReplyThread,
  listPosts,
  listSubscriptions,
  replyToPost,
  updateSubscription,
} from './service';
export { registerNetworkSubscriptions, unregisterNetworkSubscriptions } from './subscriptions';
