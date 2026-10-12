import { STATUS_CODES } from 'node:http';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from '@fastify/type-provider-zod';
import type { ErrorBody } from '@inmolink/contracts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ErrorCode, ErrorCodes, isAppError } from '../errors';
import { reportError } from '../telemetry/report';

/** The standard error body, `{ error: { code, message, details? } }` (api.md). */
export function errorBody(code: ErrorCode, details?: Record<string, unknown>): ErrorBody {
  const message = STATUS_CODES[ErrorCodes[code]] ?? 'Error';
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function sendError(reply: FastifyReply, code: ErrorCode, details?: Record<string, unknown>): FastifyReply {
  return reply.code(ErrorCodes[code]).send(errorBody(code, details));
}

/** Framework 4xx errors (bad JSON, body too large, wrong content type, …) by status. */
const FRAMEWORK_CODES: Partial<Record<number, ErrorCode>> = {
  401: 'NOT_AUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Maps every thrown error to the standard body:
 * - `AppError(code)` → the code's status (`VERSION_CONFLICT` → 409) with its details;
 * - request schema failures → 422 `VALIDATION_FAILED` with the failing paths;
 * - other framework 4xx → their code (`BAD_REQUEST` when unnamed);
 * - anything else, including a response that breaks its schema → 500 `INTERNAL`, logged, no internals sent.
 */
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (isAppError(error)) {
    if (error.status >= 500) {
      request.log.error({ err: error }, 'request failed');
      if (error.code !== 'SERVICE_UNAVAILABLE') report(error, request);
    } else request.log.info({ code: error.code }, 'request rejected');
    return sendError(reply, error.code, error.details);
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    const issues = error.validation.map((v) => ({ path: v.instancePath, message: v.message }));
    request.log.info({ in: error.validationContext, issues: issues.length }, 'validation failed');
    return sendError(reply, 'VALIDATION_FAILED', { in: error.validationContext, issues });
  }
  if (isResponseSerializationError(error)) {
    request.log.error({ err: error, issues: error.cause.issues }, 'response does not match its schema');
    report(error, request);
    return sendError(reply, 'INTERNAL');
  }
  const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (status >= 400 && status < 500) {
    request.log.info({ status, fastifyCode: error.code }, 'request rejected');
    return sendError(reply, FRAMEWORK_CODES[status] ?? 'BAD_REQUEST');
  }
  // Unmapped database errors name their SQLSTATE (e.g. 57014 statement timeout, 40P01 deadlock, 23505),
  // so a 500 says what happened without logging the query or its values (S1-09 review).
  request.log.error({ err: error, pgCode: sqlState(error) }, 'request failed');
  if (status !== 503) report(error, request);
  return sendError(reply, FRAMEWORK_CODES[status] ?? 'INTERNAL');
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The Postgres SQLSTATE of a driver error, or of the one Drizzle wraps in `cause`; undefined otherwise. */
export function sqlState(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Unexpected failures go to Sentry with the request id and route (503s are load shedding, not bugs). */
function report(error: unknown, request: FastifyRequest): void {
  reportError(error, { requestId: request.id, route: request.routeOptions.url, method: request.method });
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_request, reply) => sendError(reply, 'NOT_FOUND'));
}
