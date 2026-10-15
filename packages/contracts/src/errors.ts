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
  /** The key, or a slug in that locale, is already used. */
  TAXONOMY_KEY_TAKEN: 409,
  /** The spelling already maps to another property type or feature. */
  TAXONOMY_ALIAS_TAKEN: 409,
  // taxonomy: staff admin (S2-04)
  /** The drawn polygon is not a valid, non-self-intersecting area. */
  LOCATION_POLYGON_INVALID: 422,
  /** The ids do not match exactly the siblings (or group members) being ordered. */
  TAXONOMY_ORDER_INVALID: 422,
  // properties (S3-02)
  /** PUBLIC needs a CEE energy rating (A–G or EXEMPT; PENDING is not one), PLAN §13. */
  ENERGY_RATING_REQUIRED: 422,
  /** A status change the lifecycle does not allow (e.g. DRAFT → SOLD, a sale marked RENTED). */
  LISTING_STATUS_INVALID: 409,
  /** Restore after the 30-day window (PLAN §3 #34), or of a listing that is not deleted. */
  LISTING_RESTORE_UNAVAILABLE: 409,
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
