/**
 * Error codes and their HTTP status. Modules add their codes here (PATTERNS §9).
 * Apps map `AppError` to `{ error: { code, details } }` with this status (S0-08).
 */
export const ErrorCodes = {
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SERVICE_UNAVAILABLE: 503,
  FORBIDDEN: 403,
  NOT_AUTHENTICATED: 401,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  VERSION_CONFLICT: 409,
  PLAN_REQUIRED: 402,
  VERIFICATION_REQUIRED: 403,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  LISTING_NOT_FOUND: 404,
  // identity (S0-09). Wrong password, unknown email and disabled account are all INVALID_CREDENTIALS.
  INVALID_CREDENTIALS: 401,
  EMAIL_NOT_VERIFIED: 403,
  /** An email link that is unknown, used or expired — one code, so links cannot be probed. */
  TOKEN_INVALID: 400,
  /** The access token's session was revoked (password reset) or the user is no longer active. */
  SESSION_REVOKED: 401,
  // identity: team (S1-02)
  /** The invited email already has an account (one agency per user); the invite stays usable. */
  INVITE_EMAIL_IN_USE: 409,
  /** The email already belongs to a member of this agency. */
  ALREADY_MEMBER: 409,
  // identity: two-factor (S1-04)
  /** The session has not passed the second factor this user needs (enrolled, or a role that requires it). */
  MFA_REQUIRED: 403,
  /** A TOTP or recovery code that does not match, was already used, or no factor is enrolled. */
  MFA_CODE_INVALID: 400,
  /** 2FA is already enabled: disable it first to enrol a new authenticator. */
  MFA_ALREADY_ENABLED: 409,
  // identity: API keys (S1-05)
  /** Missing, malformed, unknown, rotated or revoked key, a key of another environment, or its agency is not verified. */
  API_KEY_INVALID: 401,
  /** A publishable key used without an `Origin`, or from an origin not on its allowlist. */
  API_KEY_ORIGIN_DENIED: 403,
  /** The key does not have the scope this endpoint needs. */
  API_KEY_SCOPE_DENIED: 403,
  /** The agency has as many active keys as allowed: revoke one first. */
  API_KEY_LIMIT_REACHED: 409,
  // websites (S7-01)
  /** No such site in the agency (or one of another agency). */
  SITE_NOT_FOUND: 404,
  /** The agency has as many sites as allowed. */
  SITE_LIMIT_REACHED: 409,
  /**
   * S7-07: no XML feed answers this URL — an unknown, rotated or revoked feed token, a site whose agency is not
   * verified, or a feed not generated yet. The same answer for each, so a token cannot be probed.
   */
  SITE_FEED_NOT_FOUND: 404,
  // exports: portal connections (S9-01)
  /** No such portal connection in the agency (or one of another agency). */
  PORTAL_CONNECTION_NOT_FOUND: 404,
  /** No such portal in the catalog, or one still waiting for the portal's partner approval. */
  PORTAL_CHANNEL_UNAVAILABLE: 409,
  /** The agency has as many portal connections as allowed. */
  PORTAL_CONNECTION_LIMIT_REACHED: 409,
  /** Another connection of the agency to this portal has that name. */
  PORTAL_CONNECTION_NAME_TAKEN: 409,
  /** A connection can hold only so many per-property choices. */
  PORTAL_OVERRIDE_LIMIT_REACHED: 409,
  /**
   * S9-03: no portal feed answers this URL — an unknown, rotated or revoked token, a connection turned off, an agency
   * not verified, or a feed not generated yet. The same answer for each, so a token cannot be probed.
   */
  PORTAL_FEED_NOT_FOUND: 404,
  // websites: API v2 (S7-03)
  /** A key created before websites existed (no site): website API v2 needs a key bound to a site — issue a new one. */
  API_KEY_SITE_REQUIRED: 403,
  /** A `/v2/changes` cursor or `since` older than the change log keeps: rebuild from `/v2/sitemap`, then poll again. */
  CHANGES_EXPIRED: 410,
  /**
   * S7-04: a website API key's daily quota (or a browser's daily share of a publishable key) is used up; `details`
   * carry `limit`, `resetAt` (UTC midnight) and `retryAfterSeconds` (also `Retry-After`).
   */
  QUOTA_EXCEEDED: 429,
  // websites: lead intake (S7-05)
  /** The form's Turnstile token is missing, used, expired or not for this site (or a secret key sent no check). */
  TURNSTILE_FAILED: 403,
  /** The `Idempotency-Key` was already used on this site with another body: send a new key for a new submission. */
  IDEMPOTENCY_KEY_REUSED: 422,
  // websites: WordPress plugin updates (S8-05)
  /** No plugin release published yet, or not this version. */
  PLUGIN_RELEASE_NOT_FOUND: 404,
  // agencies (S1-01)
  /** Name or tax id of a verified (or suspended) agency: changed only through staff re-verification. */
  AGENCY_DETAILS_LOCKED: 409,
  // agencies: verification (S1-03)
  /** Onboarding (company details) is not complete, so there is nothing to verify yet. */
  AGENCY_NOT_ONBOARDED: 409,
  /** The agency already has a request waiting for staff. */
  VERIFICATION_ALREADY_SUBMITTED: 409,
  /** Submitting needs at least one uploaded document. */
  VERIFICATION_DOCUMENTS_REQUIRED: 422,
  /** The request was already decided, or the agency is no longer PENDING. */
  VERIFICATION_NOT_OPEN: 409,
  /** The agency changed its details after the version staff reviewed: reload and review again. */
  VERIFICATION_STALE: 409,
  /** Not a PDF, PNG, JPEG or WebP by its content. */
  DOCUMENT_TYPE_NOT_ALLOWED: 415,
  /** Too many documents waiting to be submitted. */
  DOCUMENT_LIMIT_REACHED: 409,
  /** A submitted document is kept as evidence. */
  DOCUMENT_LOCKED: 409,
  // agencies: preferred agencies (S1-07)
  /** Not a verified agency in the directory (unknown, not verified, suspended), or the caller's own agency. */
  PREFERRED_AGENCY_INVALID: 422,
  /** The agency is already on the list. */
  PREFERRED_AGENCY_EXISTS: 409,
  /** The list is full: remove an agency first. */
  PREFERRED_AGENCY_LIMIT_REACHED: 409,
  // compliance: data export (S10-08)
  /** No such export in the agency. */
  DATA_EXPORT_NOT_FOUND: 404,
  /** The agency already has an export queued or running: wait for it to finish. */
  DATA_EXPORT_IN_PROGRESS: 409,
  // staff console: impersonation (S1-09)
  /** The impersonation session ended, expired or was revoked: the staff member is no longer acting as the user. */
  IMPERSONATION_ENDED: 403,
  /** Not an active member of an agency that is not suspended (or the staff member themselves). */
  IMPERSONATION_TARGET_INVALID: 422,
  // taxonomy: locations (S2-01)
  /** No such location, group or alias. */
  LOCATION_NOT_FOUND: 404,
  /** The parent is missing, or not exactly one level above the new location. */
  LOCATION_PARENT_INVALID: 422,
  /** Another location under the same parent already uses this slug in this locale. */
  LOCATION_SLUG_TAKEN: 409,
  /** The spelling (or group key) already maps to another location or group. */
  LOCATION_ALIAS_TAKEN: 409,
  // taxonomy: property types and features (S2-02)
  /** No such property type, feature or group. */
  TAXONOMY_NOT_FOUND: 404,
  /** The key is already used. */
  TAXONOMY_KEY_TAKEN: 409,
  /** Another item of the catalog already uses this slug in this locale (S3-F1). */
  TAXONOMY_SLUG_TAKEN: 409,
  /** The spelling already maps to another property type or feature. */
  TAXONOMY_ALIAS_TAKEN: 409,
  // taxonomy: staff admin (S2-04)
  /** The drawn polygon is not a valid, non-self-intersecting area. */
  LOCATION_POLYGON_INVALID: 422,
  /** The ids do not match exactly the siblings (or group members) being ordered. */
  TAXONOMY_ORDER_INVALID: 422,
  // media: videos and documents (S3-F5)
  /** Only YouTube, Vimeo and Matterport links are accepted as videos. */
  VIDEO_URL_NOT_ALLOWED: 422,
  /** This video is on the listing already. */
  VIDEO_ALREADY_ADDED: 409,
  // properties (S3-02)
  /** PUBLIC needs a CEE energy rating (A–G or EXEMPT; PENDING is not one), PLAN §13. */
  ENERGY_RATING_REQUIRED: 422,
  /** A status change the lifecycle does not allow (e.g. DRAFT → SOLD, a sale marked RENTED). */
  LISTING_STATUS_INVALID: 409,
  /** Restore after the 30-day window (PLAN §3 #34), or of a listing that is not deleted. */
  LISTING_RESTORE_UNAVAILABLE: 409,
  // properties: list and bulk actions (S3-07)
  /** A price change on a listing without a price. */
  LISTING_PRICE_MISSING: 409,
  LISTING_VIEW_NOT_FOUND: 404,
  /** The member already has `LISTING_VIEWS_MAX` saved views. */
  LISTING_VIEW_LIMIT: 409,
  /** The member already has a saved view with this name. */
  LISTING_VIEW_NAME_TAKEN: 409,
  LISTING_BULK_NOT_FOUND: 404,
  /** The member already has a bulk action waiting or running: one at a time. */
  LISTING_BULK_BUSY: 409,
  /** A bulk action's filter matches more than `LISTING_BULK_MAX` listings: narrow it. */
  LISTING_BULK_TOO_MANY: 422,
  // properties: bookmarks (S3-09)
  BOOKMARK_FOLDER_NOT_FOUND: 404,
  /** The member already has `BOOKMARK_FOLDERS_MAX` folders. */
  BOOKMARK_FOLDER_LIMIT: 409,
  /** The member already has a folder with this name. */
  BOOKMARK_FOLDER_NAME_TAKEN: 409,
  /** The folder already holds `BOOKMARKS_PER_FOLDER_MAX` listings. */
  BOOKMARK_FOLDER_FULL: 409,
  BOOKMARK_NOT_FOUND: 404,
  /** The listing is already in this folder. */
  BOOKMARK_EXISTS: 409,
  // properties: listing overrides (S3-10)
  LISTING_OVERRIDE_NOT_FOUND: 404,
  /** The agency owns the listing or development: it edits the text itself instead of overriding it. */
  LISTING_OVERRIDE_OWN_TARGET: 422,
  // media (S3-03)
  /** The stored bytes are not an accepted image type (magic bytes), whatever the name or header said. */
  MEDIA_TYPE_NOT_ALLOWED: 415,
  /** Registered before the upload finished (or the signed upload expired): check and upload again. */
  MEDIA_NOT_UPLOADED: 409,
  /** The listing already has `MEDIA_PER_LISTING_MAX` media. */
  MEDIA_LIMIT_REACHED: 409,
  MEDIA_NOT_FOUND: 404,
  /** A reorder did not name exactly the listing's media (another tab changed them): reload and retry. */
  MEDIA_ORDER_STALE: 409,
  // developments (S4-02)
  DEVELOPMENT_NOT_FOUND: 404,
  /** Another development of the agency has this reference. */
  DEVELOPMENT_REF_TAKEN: 409,
  UNIT_NOT_FOUND: 404,
  /** Another unit of the development has this reference. */
  UNIT_REF_TAKEN: 409,
  /** The development would have more than `MAX_UNITS_PER_DEVELOPMENT` units. */
  DEVELOPMENT_UNIT_LIMIT: 409,
  PRICE_LIST_NOT_FOUND: 404,
  /** The price list was already approved and applied. */
  PRICE_LIST_REVIEWED: 409,
  /** A newer price list version exists: approve that one. */
  PRICE_LIST_SUPERSEDED: 409,
  // development documents (S4-F4)
  DEVELOPMENT_DOCUMENT_NOT_FOUND: 404,
  // feed imports (S6-01)
  FEED_CONNECTION_NOT_FOUND: 404,
  FEED_RUN_NOT_FOUND: 404,
  FEED_MAPPING_PROFILE_NOT_FOUND: 422,
  /** No connector is registered under this key. */
  FEED_CONNECTOR_UNKNOWN: 422,
  /** The feed URL is not http(s), carries credentials, or names a private/internal host or address. */
  FEED_URL_NOT_ALLOWED: 422,
  /** A run of this connection is already queued or running (one at a time per connection). */
  FEED_RUN_ACTIVE: 409,
  FEED_CONNECTION_DISABLED: 409,
  /** The anomaly guard paused this connection (S6-08): resume it (accepting the change or not) before it runs. */
  FEED_CONNECTION_PAUSED: 409,
  // generic XML mapper (S6-04)
  /** The sample is not XML we can read (not XML by its first bytes, malformed, a DTD, no records). */
  FEED_SAMPLE_INVALID: 422,
  /** The mapping is invalid (unknown field, bad path, no reference or property type). */
  FEED_MAPPING_INVALID: 422,
  /** The connector needs a mapping profile and the connection has none. */
  FEED_MAPPING_REQUIRED: 422,
  /** S6-F4: a connector setting is not valid for this connector (e.g. a Resales filter alias other than 1-4). */
  FEED_SETTINGS_INVALID: 422,
  // crm: contacts (S10-01)
  CONTACT_NOT_FOUND: 404,
  /** An e-mail or phone already belongs to a contact (`details.matches`): offer the merge instead (`mergeInto`). */
  CONTACT_DUPLICATE: 409,
  /** A phone is not a valid number for its country (`details.index`: which one). */
  CONTACT_PHONE_INVALID: 422,
  /** A merge into itself, or `mergeInto` naming a contact that matches none of the e-mails / phones sent. */
  CONTACT_MERGE_INVALID: 409,
  /** The merged contact would have more e-mails, phones or tags than `CONTACT_LIMITS` (`details.field`). */
  CONTACT_MERGE_LIMIT: 409,
  CONTACT_IMPORT_NOT_FOUND: 404,
  /** The import was already started (or expired): upload the file again. */
  CONTACT_IMPORT_STARTED: 409,
  /** The upload is not a CSV / Excel file we can read, or it has no data rows (`details.reason`). */
  CONTACT_IMPORT_FILE_INVALID: 422,
  // crm: leads (S10-02)
  LEAD_NOT_FOUND: 404,
  /** A CRM body names a listing, development or unit the agency cannot see (a lead's target, a task's, event's or activity's listing). */
  LEAD_TARGET_NOT_FOUND: 422,
  // crm: activities (S10-04)
  /** A logged activity's `occurredAt` is ahead of now or more than `CRM_ACTIVITY_LIMITS.backdateDays` back. */
  ACTIVITY_DATE_OUT_OF_RANGE: 422,
  // crm: tasks (S10-05)
  TASK_NOT_FOUND: 404,
  // crm: calendar (S10-06)
  /** No such calendar event in the agency. */
  CALENDAR_EVENT_NOT_FOUND: 404,
  /** Unknown, rotated or revoked calendar feed token, or its member left the agency. */
  CALENDAR_FEED_NOT_FOUND: 404,
  // crm: acquisition board (S10-07)
  /** No such seller prospect in the agency. */
  PROSPECT_NOT_FOUND: 404,
  /** A move into `LISTED` without converting, or a converted prospect moved out of `LISTED`. */
  PROSPECT_STAGE_INVALID: 409,
  /** A conversion of a prospect without a property type or a location (send them, or set them on the prospect). */
  PROSPECT_INCOMPLETE: 422,
  // crm: pipeline (S10-03)
  PIPELINE_STAGE_NOT_FOUND: 404,
  /** Another active stage of the agency already has this name. */
  PIPELINE_STAGE_DUPLICATE: 409,
  /** The agency already has `CRM_PIPELINE_LIMITS.stages` active stages. */
  PIPELINE_STAGE_LIMIT: 409,
  /**
   * The stage cannot be archived (`details.reason`): `entry` (the stage new leads enter), `not_empty` (leads are still
   * in it: move them first) or `last_open` (the pipeline keeps at least one open stage).
   */
  PIPELINE_STAGE_LOCKED: 409,
  /** A reorder that does not name every active stage exactly once (the pipeline changed meanwhile: reload it). */
  PIPELINE_ORDER_INVALID: 409,
  // mls: client registration (S11-01)
  /**
   * Another agency registered this client for this target first and its registration is still valid (first valid
   * wins, PLAN §3 #8). Never says which agency, nor anything of its registration.
   */
  REGISTRATION_CONFLICT: 409,
  /** No such listing or development on the network (or the caller's own: a registration is to another agency). */
  REGISTRATION_TARGET_NOT_FOUND: 422,
  // mls: viewing requests (S11-02)
  /** No valid registration of the agency with this id (none, another agency's, or expired): register the client first. */
  REGISTRATION_NOT_FOUND: 404,
  /** No viewing request with this id on the caller's side (the introducer's or the owner's). */
  VIEWING_REQUEST_NOT_FOUND: 404,
  /** The registration already has an open viewing request (requested or scheduled): answer or cancel that one. */
  VIEWING_REQUEST_OPEN: 409,
  /**
   * The request's state does not allow this now (`details.reason`): `not_awaiting` (the other side must answer),
   * `closed` (declined, cancelled, expired or completed), `not_scheduled`, `too_early` (the outcome of a viewing not yet
   * due) or `expired`.
   */
  VIEWING_REQUEST_STATE: 409,
  /** The target publishes no complete commission terms (a commission or fixed amount, and a split): no snapshot to agree. */
  VIEWING_TERMS_INCOMPLETE: 422,
  // chat (S11-03)
  /** No thread with this id that the caller takes part in (none, another agency's, or one they are not in). */
  CHAT_THREAD_NOT_FOUND: 404,
  /** A thread's members must be active members of the caller's agency (and at most `CHAT_LIMITS.participants`). */
  CHAT_PARTICIPANTS_INVALID: 422,
  /** The thread's viewing request was declined, cancelled or expired: the thread is read-only. */
  CHAT_THREAD_CLOSED: 409,
  // network board (S11-05)
  /** No post with this id the caller may read (none, closed or expired for another agency, or not shared). */
  NETWORK_POST_NOT_FOUND: 404,
  /** The post was closed or has expired: no new reply thread. */
  NETWORK_POST_CLOSED: 409,
  NETWORK_SUBSCRIPTION_NOT_FOUND: 404,
  /** The member has `NETWORK_LIMITS.subscriptionsPerUser` subscriptions already. */
  NETWORK_SUBSCRIPTION_LIMIT: 422,
  // AI gateway (S12-01, ADR 0008). Features catch these and degrade (keep the owner text, "try later").
  /** The agency's monthly AI hard cap is reached: nothing was sent to the provider. */
  AI_BUDGET_EXCEEDED: 429,
  /** The AI provider is down, slow or switched off (circuit breaker open, no provider configured): retry later. */
  AI_UNAVAILABLE: 503,
  /** The model's answer failed its schema twice (one repair retry). */
  AI_OUTPUT_INVALID: 502,
  /** The model declined the request (safety refusal), or the provider rejected it as invalid. */
  AI_REFUSED: 422,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    public readonly code: ErrorCode,
    public readonly details?: Record<string, unknown>,
    public readonly retryable = false,
  ) {
    super(code);
  }

  get status(): number {
    return ErrorCodes[this.code];
  }
}

/** Duck-typed as well, so an AppError from a second copy of this package (src vs dist) still matches. */
export function isAppError(err: unknown): err is AppError {
  if (err instanceof AppError) return true;
  if (!(err instanceof Error) || err.name !== 'AppError') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(ErrorCodes, code);
}
