/**
 * social — public API (S12-07, PATTERNS §1). The only import path for other modules and apps. Social posting to
 * Facebook Pages and Instagram Business accounts, behind the `social.posting` feature flag (real Meta access: H3).
 */
export { backfillMetaUsers, checkAccounts, notifyReconnect, revokeAccount, TOKEN_CHECK } from './accounts';
export { allowedNumbers, CAPTIONS_PROMPT, CaptionsAnswer, numbersIn, numbersMatchFacts } from './caption-facts';
export { generateCaptions } from './captions';
export { configureSocial, type MetaAppConfig, metaAppFromEnv, type SocialConfig } from './config';
export { socialErrors } from './errors';
export { socialEvents } from './events';
export { socialJobs } from './jobs';
export { META_SCOPES, MetaError, MetaGraphClient } from './meta';
export { CLIENT_MODE_ALLOWED, can, SOCIAL_ACTIONS, SOCIAL_IMPERSONATION, type SocialAction } from './policy';
export { IN_FLIGHT_MS, MAX_ATTEMPTS, networkPostable, publishPost, SWEEP, sweepDuePosts } from './publish';
export {
  CAPTION_REQUESTS,
  CONNECT_STATE_TTL_MS,
  cancelSocialPost,
  completeSocialConnect,
  createSocialPost,
  disconnectSocialAccount,
  getSocialPost,
  listSocialAccounts,
  listSocialPosts,
  MAX_ACCOUNTS,
  requestSocialCaptions,
  SOCIAL_FLAG,
  startSocialConnect,
  updateSocialPost,
} from './service';
export { registerSocialSubscriptions, unregisterSocialSubscriptions } from './subscriptions';
// Never export repo or schema.
