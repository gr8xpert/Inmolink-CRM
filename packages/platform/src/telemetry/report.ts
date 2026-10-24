import { sanitizeError } from '../logger';

/**
 * `reportError` without the Sentry SDK: the server plumbing and the queue worker import only this,
 * and `initErrorReporting()` (telemetry/errors) installs the reporter. Until then it is a no-op.
 */
export interface ErrorTags {
  /** The request id (`x-request-id`) the error belongs to. */
  requestId?: string;
  /** The BullMQ job id, for job failures. */
  jobId?: string;
  /** Low-cardinality context: `route`, `pool`, `job`, … */
  [tag: string]: string | undefined;
}

type Reporter = (err: unknown, tags: ErrorTags) => void;

let reporter: Reporter | undefined;

export function setErrorReporter(next: Reporter | undefined): void {
  reporter = next;
}

/** Reports an unexpected error (5xx, dead-lettered job) with its request id. A no-op without a DSN. */
export function reportError(err: unknown, tags: ErrorTags = {}): void {
  // S10-01 review: a failed query's bound values (PII) never leave in a report.
  if (reporter) reporter(sanitizeError(err), tags);
}
