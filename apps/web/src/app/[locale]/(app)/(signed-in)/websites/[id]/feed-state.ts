/** Error codes the XML feed card explains (i18n keys `websites.feed.errors.*`); anything else is `generic`. */
export const FEED_ERRORS = ['FORBIDDEN', 'SITE_NOT_FOUND', 'VERIFICATION_REQUIRED', 'generic'] as const;
export type FeedError = (typeof FEED_ERRORS)[number];

/** A new token's feed URLs, shown once; or why turning the feed on failed. */
export interface IssuedFeedState {
  urls?: { kyero: string; generic: string };
  error?: FeedError;
}
