import type { IncomingMessage } from 'node:http';
import { type Instrumentation, registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

/** Probes and scrapes are not traced: they would be most of the spans and none of the insight. */
const UNTRACED_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

function pathOf(url: string | undefined): string {
  if (!url) return '';
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * HTTP in and out (node:http + fetch/undici), Postgres and Redis. Library spans need a parent
 * (`requireParentSpan`), so pool pings, BullMQ's blocking polls and dispatcher claims stay out of the
 * traces unless a request or job is running. Statements carry no values: pg spans keep the
 * parameterised text only, Redis spans the command name only (arguments may be cached PII).
 */
export function defaultInstrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req: IncomingMessage) => UNTRACED_PATHS.has(pathOf(req.url)),
    }),
    new UndiciInstrumentation(),
    new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
    new IORedisInstrumentation({ requireParentSpan: true, dbStatementSerializer: (cmd) => cmd }),
  ];
}

let registered = false;

/**
 * Patches the libraries. Must run before `pg`, `ioredis` and `http` are first loaded — Node apps do it in
 * `--import @inmolink/platform/telemetry/register`. Spans go to the global tracer provider, which
 * `startTelemetry()` sets later (the API's proxy provider forwards to it).
 */
export function registerDefaultInstrumentations(): void {
  if (registered) return;
  registered = true;
  registerInstrumentations({ instrumentations: defaultInstrumentations() });
}
