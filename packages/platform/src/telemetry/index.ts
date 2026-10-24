/**
 * @inmolink/platform/telemetry — OpenTelemetry traces and metrics, Sentry errors (S0-10, PLAN §3 #44).
 *
 * Node apps:
 *   node --import @inmolink/platform/telemetry/register dist/main.js     // patches http/fetch/pg/ioredis
 *   const telemetry = startObservability(config, { service: 'api', metricsPort: config.METRICS_PORT });
 *   … gracefulShutdown steps: { name: 'telemetry', run: telemetry.shutdown }
 *
 * Context crosses process boundaries as W3C `traceparent`: HTTP headers (instrumentation), outbox rows
 * (`trace_parent`, see platform/outbox) and BullMQ job metadata (`queueTelemetry`).
 */
import type { Config, telemetryEnv } from '../config';
import { flushErrors, initErrorReporting } from './errors';
import { startTelemetry, type Telemetry } from './sdk';

export { activeTraceIds, currentTraceparent, tracer, withConsumerSpan } from './context';
export { type ErrorReportingOptions, flushErrors, initErrorReporting } from './errors';
export { defaultInstrumentations, registerDefaultInstrumentations } from './instrumentations';
export { HTTP_DURATION_METRIC, QUEUE_WAIT_BUCKETS_S, QUEUE_WAIT_METRIC } from './names';
export { RedactingSpanExporter, redactSpan } from './redact';
export { type ErrorTags, reportError } from './report';
export {
  DURATION_BUCKETS_S,
  startTelemetry,
  type Telemetry,
  type TelemetryOptions,
} from './sdk';

type TelemetryConfig = Config<typeof telemetryEnv> & { NODE_ENV: string };

/** Tracing, metrics and error reporting from the `telemetryEnv` config section, in that order. */
export function startObservability(
  config: TelemetryConfig,
  options: { service: string; metricsPort?: number; trustRemoteParent?: boolean },
): Telemetry {
  const environment = config.DEPLOY_ENV ?? config.NODE_ENV;
  const telemetry = startTelemetry({
    service: options.service,
    release: config.RELEASE,
    environment,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    sampleRatio: config.OTEL_TRACES_SAMPLE_RATIO,
    trustRemoteParent: options.trustRemoteParent,
    metrics: options.metricsPort === undefined ? false : { host: config.METRICS_HOST, port: options.metricsPort },
  });
  initErrorReporting({ dsn: config.SENTRY_DSN, service: options.service, release: config.RELEASE, environment });
  return {
    prometheus: telemetry.prometheus,
    async shutdown() {
      await flushErrors();
      await telemetry.shutdown();
    },
  };
}
