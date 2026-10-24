/** Error codes the feed card explains (i18n keys `calendar.feed.errors.*`); anything else is `generic`. */
export const FEED_ERRORS = ['FORBIDDEN', 'generic'] as const;
export type FeedError = (typeof FEED_ERRORS)[number];

/** A new feed URL, shown once; or why it could not be made. */
export interface IssuedCalendarFeed {
  url?: string;
  error?: FeedError;
}
