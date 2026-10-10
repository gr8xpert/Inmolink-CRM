import { type Attributes, type Context, type Link, metrics, SpanKind } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AggregationType, type IMetricReader, MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { HTTP_DURATION_METRIC } from './names';
import { RedactingSpanExporter } from './redact';

/** Histogram buckets (seconds) for request and job durations: 5 ms … 10 s. */
export const DURATION_BUCKETS_S = [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10];

/** BullMQ's timer-driven housekeeping: a root trace every few seconds per queue, never useful alone. */
const HOUSEKEEPING_SPANS = new Set([
  'startStalledCheckTimer',
  'moveStalledJobsToWait',
  'extendLocks',
  'getNextJob',
  'promoteJobs',
  'drain',
  'trimEvents',
]);

/** Root sampler: drops housekeeping roots, samples the rest by trace-id ratio. */
export class RootSampler implements Sampler {
  private readonly ratio: Sampler;

  constructor(ratio: number) {
    this.ratio = new TraceIdRatioBasedSampler(ratio);
  }

  shouldSample(
    ctx: Context,
    traceId: string,
    name: string,
    kind: SpanKind,
    attrs: Attributes,
    links: Link[],
  ): SamplingResult {
    if (kind === SpanKind.INTERNAL && HOUSEKEEPING_SPANS.has(name.split(' ', 1)[0] ?? '')) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.ratio.shouldSample(ctx, traceId, name, kind, attrs, links);
  }

  toString(): string {
    return `RootSampler{${this.ratio.toString()}}`;
  }
}

export function samplerFor(options: Pick<TelemetryOptions, 'sampleRatio' | 'trustRemoteParent'>): Sampler {
  const root = new RootSampler(options.sampleRatio ?? 1);
  if (options.trustRemoteParent ?? true) return new ParentBasedSampler({ root });
  return new ParentBasedSampler({ root, remoteParentSampled: root, remoteParentNotSampled: root });
}

export interface TelemetryOptions {
  /** `api`, `feed-api`, `worker`, … — the trace's service name. */
  service: string;
  /** `RELEASE` (git SHA). */
  release: string;
  /** `DEPLOY_ENV` or NODE_ENV. */
  environment: string;
  /** `OTEL_EXPORTER_OTLP_ENDPOINT`; without it (and without `spanExporter`) spans are not exported. */
  otlpEndpoint?: string;
  /** `OTEL_TRACES_SAMPLE_RATIO` for new traces (default 1). */
  sampleRatio?: number;
  /**
   * Obey an inbound `traceparent`'s sampled flag. `false` for internet-facing apps (api, feed-api,
   * web): a client sending `…-01` must not force every request into the trace pipeline, so remote
   * parents are re-sampled by the ratio. The ratio sampler decides on the trace id, so a trace our
   * web server sampled is sampled by api too (same ratio, same id). Default `true` (worker).
   */
  trustRemoteParent?: boolean;
  /** Prometheus `/metrics` server (`METRICS_HOST`/`METRICS_PORT`). `false`: no scrape endpoint. */
  metrics?: { host: string; port: number } | false;
  /** Tests: export spans here instead of OTLP. */
  spanExporter?: SpanExporter;
  /** Tests: synchronous export, so spans are visible right after they end. */
  simpleExport?: boolean;
  /** Tests: read metrics here instead of (or as well as) the Prometheus server. */
  metricReaders?: IMetricReader[];
}

export interface Telemetry {
  readonly prometheus?: PrometheusExporter;
  /** Flushes spans and stops the exporters (graceful shutdown step). */
  shutdown(): Promise<void>;
}

let active: Telemetry | undefined;

/**
 * Starts tracing and metrics for this process (PLAN §3 #44, §17). Call once from `main.ts`, after the
 * config is loaded; the instrumentations were registered earlier by the `--import` preload.
 * Spans: parent-based ratio sampling → batch → OTLP/HTTP to the collector (query strings stripped).
 * Metrics: a Prometheus scrape endpoint on a private port. The HTTP instrumentation's own duration
 * metric is dropped — the server plumbing records one per route (`http.server.request.duration`).
 */
export function startTelemetry(options: TelemetryOptions): Telemetry {
  if (active) return active;
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.service,
    [ATTR_SERVICE_VERSION]: options.release,
    'deployment.environment.name': options.environment,
  });

  const exporter =
    options.spanExporter ??
    (options.otlpEndpoint
      ? new OTLPTraceExporter({ url: new URL('/v1/traces', options.otlpEndpoint).href, timeoutMillis: 5_000 })
      : undefined);
  const spanProcessors: SpanProcessor[] = [];
  if (exporter) {
    const redacting = new RedactingSpanExporter(exporter);
    spanProcessors.push(
      options.simpleExport
        ? new SimpleSpanProcessor(redacting)
        : new BatchSpanProcessor(redacting, { maxQueueSize: 4_096, maxExportBatchSize: 512 }),
    );
  }
  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: samplerFor(options),
    spanProcessors,
  });
  // Global provider + AsyncLocalStorage context manager + W3C trace-context/baggage propagators.
  // W3C trace context only: no baggage, so client-sent baggage never reaches job metadata or outgoing calls.
  tracerProvider.register({ propagator: new W3CTraceContextPropagator() });

  let prometheus: PrometheusExporter | undefined;
  const readers: IMetricReader[] = [...(options.metricReaders ?? [])];
  if (options.metrics) {
    const { host, port } = options.metrics;
    prometheus = new PrometheusExporter({ host, port });
    readers.push(prometheus);
  }
  const meterProvider = new MeterProvider({
    resource,
    readers,
    views: [
      { meterName: '@opentelemetry/instrumentation-http', aggregation: { type: AggregationType.DROP } },
      { meterName: '@opentelemetry/instrumentation-undici', aggregation: { type: AggregationType.DROP } },
      {
        instrumentName: HTTP_DURATION_METRIC,
        aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS_S } },
      },
      {
        // BullMQ records job durations in milliseconds.
        instrumentName: 'bullmq.job.duration',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: DURATION_BUCKETS_S.map((s) => s * 1_000) },
        },
      },
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const telemetry: Telemetry = {
    prometheus,
    async shutdown() {
      active = undefined;
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
  active = telemetry;
  return telemetry;
}
