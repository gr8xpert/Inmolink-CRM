import type { Attributes } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace-node';

/** URL attributes the HTTP/fetch instrumentations set; their query strings may carry tokens. */
const URL_ATTRIBUTES = new Set(['url.full', 'http.url', 'http.target', 'url.original']);

/**
 * Dropped outright: query strings, client addresses (personal data under GDPR, and `client.address`
 * comes from a spoofable `X-Forwarded-For` entry), user agents, and job return values (a job could
 * return a rendered email with a one-time link).
 */
const DROPPED_ATTRIBUTES = new Set([
  'url.query',
  'client.address',
  'client.port',
  'network.peer.address',
  'net.peer.ip',
  'http.client_ip',
  'user_agent.original',
  'http.user_agent',
  'bullmq.job.result',
]);

/** Free-text values (error messages, failure reasons) are capped. */
const MAX_TEXT = 500;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Removes email addresses from free text (SMTP rejections, pg errors) and caps its length. Shared by
 * the span exporter and the Sentry scrub.
 */
export function scrubText(text: string): string {
  const clean = text.replace(EMAIL, '[email]');
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
}

function stripQuery(value: string): string {
  const i = value.indexOf('?');
  return i === -1 ? value : value.slice(0, i);
}

/** Query strings inside a span name (Next.js names fetch spans `fetch GET <url>`). */
const NAME_QUERY = /\?[^\s]*/g;

/** Clean copy of `attrs`, or `attrs` itself when nothing changed. */
function redactAttributes(attrs: Attributes): Attributes {
  let next: Record<string, unknown> | undefined;
  const put = (key: string, value: unknown) => {
    next ??= { ...attrs };
    if (value === undefined) delete next[key];
    else next[key] = value;
  };
  for (const [key, value] of Object.entries(attrs)) {
    if (DROPPED_ATTRIBUTES.has(key)) put(key, undefined);
    else if (typeof value !== 'string') continue;
    else if (URL_ATTRIBUTES.has(key)) {
      if (value.includes('?')) put(key, stripQuery(value));
    } else {
      const clean = scrubText(value);
      if (clean !== value) put(key, clean);
    }
  }
  return next ? Object.freeze(next as Attributes) : attrs;
}

/** The span without query strings, client addresses or email addresses — or the span itself if clean. */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  const name = span.name.includes('?') ? span.name.replace(NAME_QUERY, '') : span.name;
  const attributes = redactAttributes(span.attributes);
  let eventsChanged = false;
  const events = span.events.map((e): TimedEvent => {
    if (!e.attributes) return e;
    const clean = redactAttributes(e.attributes);
    if (clean === e.attributes) return e;
    eventsChanged = true;
    return { ...e, attributes: clean };
  });
  const message = span.status.message;
  const statusMessage = message === undefined ? undefined : scrubText(message);

  if (name === span.name && attributes === span.attributes && !eventsChanged && statusMessage === message) return span;
  // Keeps the span's prototype (spanContext(), getters) and overrides only what changed.
  return Object.create(span, {
    name: { value: name, enumerable: true },
    attributes: { value: attributes, enumerable: true },
    events: { value: eventsChanged ? events : span.events, enumerable: true },
    status: { value: { ...span.status, message: statusMessage }, enumerable: true },
  }) as ReadableSpan;
}

/**
 * Exporter wrapper: spans leave the process without query strings (reset links, API keys), client
 * addresses or email addresses — the same rules as request logs (`stripQuery`, redaction in platform/logger).
 */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
