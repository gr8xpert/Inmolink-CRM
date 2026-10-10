// Patches http/fetch/pg/ioredis before anything below loads them — what `--import` does for the apps.
import '@inmolink/platform/telemetry/register';
import { createDispatcher, defineEvent, emit, PLATFORM_AGENCY_ID, SubscriberRegistry } from '@inmolink/platform/outbox';
import { defineJob, registerPool } from '@inmolink/platform/queue';
import { createServer } from '@inmolink/platform/server';
import { startTelemetry, type Telemetry } from '@inmolink/platform/telemetry';
import { SpanKind, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  log,
  pendingOf,
  pruneTestOutbox,
  runId,
  runSystem,
  setupQueueTest,
  teardownQueueTest,
  waitFor,
} from './helpers';

const run = runId();
const pool = `trace-${run}`;
const exporter = new InMemorySpanExporter();
let telemetry: Telemetry;

const noted = defineEvent(`test.${run}.traced`, 1, z.object({ n: z.number().int() }));
const done: number[] = [];
const followUp = defineJob({
  pool,
  name: 'traced.followUp',
  payload: z.object({ n: z.number().int() }),
  jobId: (p) => `n-${p.n}`,
  run: async (p) => {
    // A query inside the job: the worker's Postgres spans belong to the same trace.
    await runSystem('test.trace.job', (tx) => tx.execute(sql`select 1`));
    done.push(p.n);
  },
});

const spansOf = (traceId: string) => exporter.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);
const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;

describe('telemetry', () => {
  beforeAll(async () => {
    telemetry = startTelemetry({
      service: 'trace-test',
      release: 'test',
      environment: 'test',
      spanExporter: exporter,
      simpleExport: true,
      metrics: false,
    });
    await setupQueueTest(`test-${run}`);
    await pruneTestOutbox();
  });
  afterAll(async () => {
    await teardownQueueTest([pool]);
    await telemetry.shutdown();
  });

  it('[S0-10] one trace links web → api → Postgres → outbox → worker', async () => {
    // "api": a route that writes and emits in one transaction (PATTERNS §7).
    const api = await createServer({ logger: log, trustProxy: false, openapi: { title: 'trace', version: '0' } });
    api.post('/v1/notes', async (_request, reply) => {
      await runSystem('test.trace.api', async (tx) => {
        await tx.execute(sql`select 1`);
        await emit(tx, noted({ n: 7 }), { agencyId: PLATFORM_AGENCY_ID });
      });
      return reply.code(202).send({ ok: true });
    });
    const url = await api.listen({ host: '127.0.0.1', port: 0 });

    // "worker": the outbox subscriber enqueues a job; the pool runs it.
    const subscribers = new SubscriberRegistry();
    subscribers.add(noted, async (p) => {
      await followUp.enqueue(p);
    });
    const dispatcher = createDispatcher({ runSystem, logger: log, subscribers });
    const handle = registerPool(pool, [followUp], { concurrency: 1 });

    try {
      // "web": its server code calls the API with fetch inside its own request span.
      const traceId = await trace.getTracer('web').startActiveSpan('web GET /dashboard', async (span) => {
        const res = await fetch(`${url}/v1/notes?token=secret`, { method: 'POST' });
        expect(res.status).toBe(202);
        span.end();
        return span.spanContext().traceId;
      });

      await waitFor(async () => {
        await dispatcher.runOnce();
        return (await pendingOf([noted.type])) === 0 && done.includes(7);
      });
      // The job's `process` span ends after the handler returns; wait for it to be exported.
      const isJob = (s: ReadableSpan) => s.kind === SpanKind.CONSUMER && s.name === `process ${pool}`;
      await waitFor(() => spansOf(traceId).some(isJob));

      const spans = spansOf(traceId);
      const one = (fn: (s: ReadableSpan) => boolean, what: string): ReadableSpan => {
        const found = spans.find(fn);
        expect(found, `${what} in [${spans.map((s) => s.name).join(', ')}]`).toBeDefined();
        return found as ReadableSpan;
      };
      const id = (s: ReadableSpan) => s.spanContext().spanId;
      const isPg = (s: ReadableSpan) => s.name.startsWith('pg.query');

      const web = one((s) => s.name === 'web GET /dashboard', 'web span');
      const fetchSpan = one((s) => s.kind === SpanKind.CLIENT && parentOf(s) === id(web), 'fetch from web');
      const api = one((s) => s.kind === SpanKind.SERVER && s.name === 'POST /v1/notes', 'api server span');
      const apiInsert = one((s) => isPg(s) && s.name.includes('INSERT') && parentOf(s) === id(api), 'api INSERT');
      const deliver = one((s) => s.name === `outbox deliver ${noted.type}`, 'outbox delivery');
      one((s) => s.kind === SpanKind.PRODUCER && parentOf(s) === id(deliver), 'enqueue');
      // The job continues the context captured when the subscriber enqueued it (batched adds send later).
      const job = one((s) => isJob(s) && parentOf(s) === id(deliver), 'job');
      one((s) => isPg(s) && parentOf(s) === id(job), 'job query');

      expect(parentOf(api)).toBe(id(fetchSpan));
      // The outbox row carried the api span's context across the commit.
      expect(parentOf(deliver)).toBe(id(api));
      expect(deliver.kind).toBe(SpanKind.CONSUMER);
      expect(api.attributes['http.route']).toBe('/v1/notes');
      expect(apiInsert.attributes['db.query.text'] ?? apiInsert.attributes['db.statement']).toContain('outbox_events');
      // Query strings never leave the process.
      for (const s of spans) {
        for (const v of Object.values(s.attributes)) expect(String(v)).not.toContain('token=secret');
      }
    } finally {
      await handle.close();
      await api.close();
    }
  });
});
