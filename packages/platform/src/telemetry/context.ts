import {
  type Attributes,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

/** Tracer for spans Inmolink code creates itself (outbox delivery, …). */
export const tracer = () => trace.getTracer('@inmolink/platform');

/** Trace and span id of the active span, for log lines; `undefined` outside a sampled span. */
export function activeTraceIds(): { traceId: string; spanId: string } | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx || !trace.isSpanContextValid(ctx)) return undefined;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/** W3C `traceparent` of the active span — stored with work that continues elsewhere (outbox rows). */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * Runs `fn` in a `CONSUMER` span whose parent is the stored `traceparent` (or a new trace when there is
 * none), so work picked up from a table continues the trace that produced it. Throws are recorded on
 * the span and rethrown.
 */
export async function withConsumerSpan<T>(
  name: string,
  traceparent: string | null | undefined,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent =
    traceparent && TRACEPARENT.test(traceparent) ? propagation.extract(ROOT_CONTEXT, { traceparent }) : ROOT_CONTEXT;
  return tracer().startActiveSpan(name, { kind: SpanKind.CONSUMER, attributes }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
