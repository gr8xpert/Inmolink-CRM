import type { Breadcrumb, ErrorEvent, EventHint, NodeOptions } from '@sentry/node';
import * as Sentry from '@sentry/node';
import { redactPathsInText } from '../logger';
import { activeTraceIds } from './context';
import { scrubText } from './redact';
import { type ErrorTags, setErrorReporter } from './report';

export interface ErrorReportingOptions {
  /** `SENTRY_DSN`; without it nothing is sent. */
  dsn?: string;
  service: string;
  release: string;
  environment: string;
  /** Tests: inspect events; return `null` to drop. Runs after the PII scrub. */
  beforeSend?: (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;
  /** Tests: a transport that sends nowhere. */
  transport?: NodeOptions['transport'];
}

/**
 * Framework integrations that capture errors on their own — without our request id. The server
 * plumbing reports 5xx itself (platform/server `errorHandler`), so these would only send duplicates.
 */
const SELF_REPORTING = new Set(['Fastify', 'Express', 'Hapi', 'Koa', 'Hono']);

/**
 * Sentry's own HTTP/fetch patching: OpenTelemetry already traces both, and these would add
 * `sentry-trace` + `baggage` (public key, release) to every outgoing request — feeds and webhooks
 * included. Scopes are set explicitly in `capture()`, so request isolation is not needed.
 */
const DUPLICATE_HTTP = new Set(['Http', 'NodeFetch']);

/** No query string, and no credential path segment (S8-F1: feed tokens in `/v2/feeds/<token>/…`). */
const stripQuery = (url: string) => redactPathsInText(url.split('?', 1)[0] as string);
/** PII and credential path segments out of a free text (messages can quote a URL). */
const scrubMessage = (text: string) => redactPathsInText(scrubText(text));

/** HTTP/fetch breadcrumbs: no query strings (reset links, API keys on outgoing calls), no credential path segments. */
function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const data = crumb.data;
  if (!data) return crumb.message ? { ...crumb, message: scrubMessage(crumb.message) } : crumb;
  const { 'http.query': _q, 'http.fragment': _f, ...rest } = data;
  if (typeof rest.url === 'string') rest.url = stripQuery(rest.url);
  return { ...crumb, ...(crumb.message ? { message: scrubMessage(crumb.message) } : {}), data: rest };
}

/** Request data Sentry may attach that can hold credentials or PII. Exported for tests. */
export function scrubErrorEvent(event: ErrorEvent): ErrorEvent {
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  // SMTP and pg messages can quote addresses or row values; any message can quote a request URL.
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrubMessage(ex.value);
  if (event.message) event.message = scrubMessage(event.message);
  if (event.transaction) event.transaction = redactPathsInText(event.transaction);
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.url) event.request.url = stripQuery(event.request.url);
    if (event.request.headers) {
      const { authorization: _a, cookie: _c, 'x-api-key': _k, ...headers } = event.request.headers;
      event.request.headers = headers;
    }
  }
  if (event.user) event.user = event.user.id === undefined ? undefined : { id: event.user.id };
  return event;
}

let enabled = false;

/**
 * Sentry for Node (PLAN §3 #44): errors only. Tracing stays with OpenTelemetry — Sentry's own
 * OpenTelemetry setup is off and `tracesSampleRate` unset; `openTelemetryIntegration` links each error
 * to the active span. Call after `startTelemetry()`. Events carry `release`, `environment`, `service`.
 */
export function initErrorReporting(options: ErrorReportingOptions): void {
  if (!options.dsn) return;
  Sentry.init({
    dsn: options.dsn,
    release: options.release,
    environment: options.environment,
    enableOpenTelemetrySetup: false,
    sendClientReports: false,
    // No cookies, headers, bodies, query strings or user fields (PII and tokens); request id + route come as tags.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      // Off on purpose, so turning on a feature later cannot start sending locals (passwords) or queries.
      stackFrameVariables: false,
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    tracePropagationTargets: [],
    integrations: (defaults) => [
      ...defaults.filter((i) => !SELF_REPORTING.has(i.name) && !DUPLICATE_HTTP.has(i.name)),
      Sentry.openTelemetryIntegration(),
    ],
    ...(options.transport ? { transport: options.transport } : {}),
    initialScope: { tags: { service: options.service } },
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend(event, hint) {
      const clean = scrubErrorEvent(event);
      return options.beforeSend ? options.beforeSend(clean, hint) : clean;
    },
  });
  enabled = true;
  setErrorReporter(capture);
}

function capture(err: unknown, tags: ErrorTags): void {
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) if (value !== undefined) scope.setTag(key, value);
    const ids = activeTraceIds();
    if (ids) scope.setTag('trace_id', ids.traceId);
    Sentry.captureException(err);
  });
}

/** Sends queued events before exit (graceful shutdown step). */
export async function flushErrors(timeoutMs = 2_000): Promise<void> {
  if (!enabled) return;
  setErrorReporter(undefined);
  await Sentry.close(timeoutMs);
  enabled = false;
}
