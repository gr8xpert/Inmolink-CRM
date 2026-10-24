import { type DestinationStream, type Logger, type LoggerOptions, pino } from 'pino';
import { activeTraceIds } from '../telemetry/context';

/**
 * Structured JSON logs (pino). PII and secrets are redacted by key name at the top
 * level and up to three levels deep (`*.email`, `*.*.email`, `*.*.*.email`).
 * Keys are matched exactly (case-sensitive), so PII fields use these canonical names
 * (`email`, not `ownerEmail`). Depth stays at 3 to keep redaction cheap on feed-api.
 * `key` is on the list by design (acceptance check S0-03): log cache/S3 keys as `cacheKey`/`objectKey`.
 */
export const REDACT_KEYS = [
  // Person names (S1-F5). Log a queue, rule or check under its own key (`queue`, `rule`), never `name`;
  // an error's own `name` is redacted too — its class stays in `type`.
  'name',
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'mobile',
  // Names in staff, member and invite DTOs (S2-F2); a self-employed agent's company name is their own.
  'userName',
  'memberName',
  'staffName',
  'impersonatedByName',
  'companyName',
  'emailSenderName',
  // Agency contact details, address, invite and verification-document fields (S2-F2): personal for one-person
  // agencies. Log an upload by its document id or `objectKey`, never its `fileName`.
  'contactEmail',
  'contactPhone',
  'websiteUrl',
  'addressLine',
  'fileName',
  'decisionReason',
  'password',
  'passwordHash',
  // CIF / NIF / NIE: a personal national id for self-employed agents (S1-01).
  'taxId',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'key',
  'apiKey',
  // The v1 shim's legacy key parameter (S8-02), should a parsed query ever be logged.
  'api_key',
  'secret',
  'clientSecret',
  'authorization',
  'cookie',
  'set-cookie',
  'totp',
  'otp',
  'recoveryCodes',
  'privateKey',
  'credentials',
  'connectionString',
  'iban',
  'dni',
  'nie',
  'nif',
  'passport',
  'dateOfBirth',
  'x-api-key',
  'proxy-authorization',
  'stripe-signature',
  'x-hub-signature-256',
  // Website forms (S8-F4): a lead's WhatsApp number, the page it was sent from and its viewing slots (`slots` in the
  // viewing-request body) are the visitor's; Turnstile tokens and idempotency keys are single-use credentials. Paths
  // are case-sensitive: Node lower-cases incoming headers, the capitalised spellings cover headers built by hand.
  // `message` stays logged: redacting it would hide every error's message.
  'whatsapp',
  'pageUrl',
  'viewingSlots',
  'slots',
  'turnstileToken',
  'cf-turnstile-response',
  'CF-Turnstile-Response',
  'idempotencyKey',
  'idempotency-key',
  'Idempotency-Key',
] as const;

/** Error fields that may echo row values (pg `detail`, query parameters) — dropped from logs. */
// `command`/`args`: ioredis attaches the failed command, whose arguments may be a cached value with PII.
// `params`: Drizzle's `DrizzleQueryError` carries the bound values of the failed query (S10-01 review).
const UNSAFE_ERROR_FIELDS = [
  'detail',
  'parameters',
  'params',
  'query',
  'where',
  'internalQuery',
  'command',
  'args',
] as const;

/**
 * S10-01 review: Drizzle's `DrizzleQueryError` message is `Failed query: <sql>\nparams: <values>` — the bound values
 * (e-mails, phones, names) would reach logs, dead-letter reasons, BullMQ's `failedReason` and error reports. Everything
 * from `params:` up to the stack frames is replaced; the SQL text (placeholders only) stays for debugging.
 */
const PARAMS_MARKER = '\nparams:';

export function redactQueryParams(text: string): string {
  const start = text.indexOf(PARAMS_MARKER);
  if (start === -1) return text;
  const frames = text.indexOf('\n    at ', start);
  return `${text.slice(0, start)}${PARAMS_MARKER} ${REDACTED}${frames === -1 ? '' : text.slice(frames)}`;
}

/**
 * Makes an error safe to log, report or store as a job's failure reason, in place: the query parameters in the message
 * and stack of the error and of its `cause` chain are redacted, and a `params` field is dropped. Returns the same error.
 */
export function sanitizeError<T>(err: T): T {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e instanceof Error; depth += 1) {
    if (e.message.includes(PARAMS_MARKER)) e.message = redactQueryParams(e.message);
    if (e.stack?.includes(PARAMS_MARKER)) e.stack = redactQueryParams(e.stack);
    if ('params' in e) {
      try {
        (e as { params?: unknown }).params = REDACTED;
      } catch {
        // a read-only field: the serializer drops it anyway
      }
    }
    e = (e as { cause?: unknown }).cause;
  }
  return err;
}

function scrub(out: Record<string, unknown>, depth: number): void {
  for (const field of UNSAFE_ERROR_FIELDS) delete out[field];
  if (typeof out.message === 'string') out.message = redactQueryParams(out.message);
  if (typeof out.stack === 'string') out.stack = redactQueryParams(out.stack);
  const cause = out.cause;
  if (depth < 3 && cause && typeof cause === 'object') scrub(cause as Record<string, unknown>, depth + 1);
}

function errSerializer(err: unknown): unknown {
  const out = pino.stdSerializers.err(err as Error) as unknown as Record<string, unknown>;
  scrub(out, 0);
  // A wrapped driver error (DrizzleQueryError → pg): keep what identifies the failure — SQLSTATE and constraint.
  const cause = (err as { cause?: { code?: unknown; constraint?: unknown } } | null)?.cause;
  if (cause && typeof cause === 'object') {
    if (typeof cause.code === 'string' && out.causeCode === undefined) out.causeCode = cause.code;
    if (typeof cause.constraint === 'string' && out.constraint === undefined) out.constraint = cause.constraint;
  }
  return out;
}

/**
 * Path segments that are credentials (S7-07: per-site XML feed tokens, `/v2/feeds/<token>/…`; S9-01: per-connection
 * portal feed tokens, `/v2/portal-feeds/<token>/…`, served from S9-04): never in a log line, a
 * trace or an error report.
 */
const SECRET_PATHS: readonly RegExp[] = [/^(\/v2\/feeds\/)[^/?#]+/, /^(\/v2\/portal-feeds\/)[^/?#]+/];
/**
 * The same segments anywhere in a text: a full URL, an error message, a breadcrumb (S8-F1: error reports). Also the
 * legacy `api_key` query parameter (S8-02: the v1 shim takes a flagged legacy key in the URL), which a quoted URL in a
 * message would otherwise carry into an error report.
 */
const SECRET_PATHS_IN_TEXT: readonly RegExp[] = [
  /(\/v2\/feeds\/)[^/?#\s"'<>]+/g,
  /(\/v2\/portal-feeds\/)[^/?#\s"'<>]+/g,
  /([?&]api_key=)[^&#\s"'<>]+/g,
];

/** A path with its credential segments replaced by `[REDACTED]`. */
export function redactPath(path: string): string {
  let out = path;
  for (const re of SECRET_PATHS) out = out.replace(re, `$1${REDACTED}`);
  return out;
}

/** Credential path segments redacted wherever they appear in a text (full URLs included), like `redactPath`. */
export function redactPathsInText(text: string): string {
  let out = text;
  for (const re of SECRET_PATHS_IN_TEXT) out = out.replace(re, `$1${REDACTED}`);
  return out;
}

/**
 * Drops the query string (reset tokens, API keys) and redacts credential path segments (`redactPath`) — use for any
 * URL that goes into a log.
 */
export function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return redactPath(i === -1 ? url : url.slice(0, i));
}

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 3;

export function redactPaths(keys: readonly string[] = REDACT_KEYS): string[] {
  const paths: string[] = [];
  for (const key of keys) {
    const plain = /^[A-Za-z_$][\w$]*$/.test(key);
    let prefix = '';
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      paths.push(plain ? `${prefix}${prefix ? '.' : ''}${key}` : `${prefix}["${key}"]`);
      prefix += prefix ? '.*' : '*';
    }
  }
  return paths;
}

export interface CreateLoggerOptions {
  level?: string;
  /** App or worker name, e.g. `api`, `feed-api`, `worker:imports`. */
  service?: string;
  /** Extra keys to redact on top of `REDACT_KEYS`. */
  redact?: readonly string[];
  /** For tests; defaults to stdout. */
  destination?: DestinationStream;
}

export type { Logger };

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: options.service ? { service: options.service } : null,
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: errSerializer, error: errSerializer },
    redact: { paths: redactPaths([...REDACT_KEYS, ...(options.redact ?? [])]), censor: REDACTED },
    // Lines written inside a sampled span carry its ids, so a log line opens its trace (S0-10).
    mixin: () => activeTraceIds() ?? {},
  };
  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

/** Child logger bound to one request/job, so every line carries its id. */
export function withRequestId(logger: Logger, requestId: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ ...bindings, requestId });
}
