/** Error codes the social pages explain (i18n keys `social.errors.*`); anything else is `generic`. */
export const SOCIAL_NOTICE_ERRORS = [
  'FORBIDDEN',
  'SOCIAL_NOT_ENABLED',
  'SOCIAL_ACCOUNT_NOT_FOUND',
  'SOCIAL_POST_NOT_FOUND',
  'SOCIAL_ACCOUNT_NEEDS_RECONNECT',
  'SOCIAL_POST_NOT_EDITABLE',
  'SOCIAL_CONNECT_FAILED',
  'SOCIAL_PROVIDER_UNAVAILABLE',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'LISTING_NOT_FOUND',
  'RATE_LIMITED',
] as const;
export type SocialNoticeError = (typeof SOCIAL_NOTICE_ERRORS)[number] | 'generic';

/** Notices after a form (`?done=`). */
export const SOCIAL_DONE = ['connected', 'disconnected', 'scheduled', 'drafted', 'cancelled'] as const;

/** Why a post failed, as the history explains it (`social.postErrors.*`); others show their code. */
export const SOCIAL_POST_ERRORS = [
  'OUTCOME_UNKNOWN',
  'ACCOUNT_NEEDS_RECONNECT',
  'ACCOUNT_NOT_FOUND',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'REJECTED',
  'NETWORK',
  'LISTING_UNAVAILABLE',
  'NO_IMAGES',
  'NOT_CONFIGURED',
] as const;
