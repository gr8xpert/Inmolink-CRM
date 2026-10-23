/** Error codes the portal pages explain (i18n keys `portals.errors.*`); anything else is `generic`. */
export const PORTAL_ERRORS = [
  'FORBIDDEN',
  'PORTAL_CONNECTION_NOT_FOUND',
  'PORTAL_CHANNEL_UNAVAILABLE',
  'PORTAL_CONNECTION_LIMIT_REACHED',
  'PORTAL_CONNECTION_NAME_TAKEN',
  'PORTAL_OVERRIDE_LIMIT_REACHED',
  'LISTING_NOT_FOUND',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
] as const;
export type PortalError = (typeof PORTAL_ERRORS)[number] | 'generic';

/** What the create and rotate forms come back with: the new feed token (shown once) or an error. */
export interface IssuedTokenState {
  token?: string;
  connectionId?: string;
  error?: PortalError;
}
