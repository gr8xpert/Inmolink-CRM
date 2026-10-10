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
