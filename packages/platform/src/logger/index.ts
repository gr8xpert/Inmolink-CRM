import { type DestinationStream, type Logger, type LoggerOptions, pino } from 'pino';

/**
 * Structured JSON logs (pino). PII and secrets are redacted by key name at the top
 * level and up to three levels deep (`*.email`, `*.*.email`, `*.*.*.email`).
 * Keys are matched exactly (case-sensitive), so PII fields use these canonical names
 * (`email`, not `ownerEmail`). Depth stays at 3 to keep redaction cheap on feed-api.
 * `key` is on the list by design (acceptance check S0-03): log cache/S3 keys as `cacheKey`/`objectKey`.
 */
export const REDACT_KEYS = [
  'email',
  'phone',
  'mobile',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'key',
  'apiKey',
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
  'taxId',
  'dateOfBirth',
  'x-api-key',
  'proxy-authorization',
  'stripe-signature',
  'x-hub-signature-256',
] as const;

/** Error fields that may echo row values (pg `detail`, query parameters) — dropped from logs. */
// `command`/`args`: ioredis attaches the failed command, whose arguments may be a cached value with PII.
const UNSAFE_ERROR_FIELDS = ['detail', 'parameters', 'query', 'where', 'internalQuery', 'command', 'args'] as const;

function errSerializer(err: unknown): unknown {
  const out = pino.stdSerializers.err(err as Error) as unknown as Record<string, unknown>;
  for (const field of UNSAFE_ERROR_FIELDS) delete out[field];
  return out;
}

/** Drops the query string (reset tokens, API keys) — use for any URL that goes into a log. */
export function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
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
  };
  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

/** Child logger bound to one request/job, so every line carries its id. */
export function withRequestId(logger: Logger, requestId: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ ...bindings, requestId });
}
