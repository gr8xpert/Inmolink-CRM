import { createServer as createHttpServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { Writable } from 'node:stream';
import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace-node';
import type { ErrorEvent } from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { createLogger } from '../logger';
import { createServer, type FastifyZod } from '../server';
import { flushErrors, initErrorReporting } from './errors';
import { redactSpan } from './redact';
import { samplerFor, startTelemetry, type Telemetry } from './sdk';

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as { port: number };
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// The first Sentry event loads integrations lazily (context lines, modules); on a busy 4-vCPU CI
// runner that alone took longer than Vitest's 5 s default. Event delivery is asserted, not its speed.
const SENTRY_EVENT_MS = 15_000;

async function until(check: () => boolean, ms = SENTRY_EVENT_MS - 1_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const messageOf = (e: ErrorEvent) => e.exception?.values?.[0]?.value ?? e.message ?? '?';

/** The event of one request (matched by its id in the message); a timeout lists what did arrive. */
async function eventFor(requestId: unknown): Promise<ErrorEvent> {
  const find = () => events.find((e) => messageOf(e).includes(String(requestId)));
  try {
    await until(() => find() !== undefined);
  } catch {
    throw new Error(`no event for ${String(requestId)}; received: ${JSON.stringify(events.map(messageOf))}`);
  }
  return find() as ErrorEvent;
}

const events: ErrorEvent[] = [];
let telemetry: Telemetry;
let metricsUrl: string;
let app: FastifyZod;
let upstreamHeaders: IncomingHttpHeaders | undefined;
const upstream = createHttpServer((req, res) => {
  upstreamHeaders = req.headers;
  res.writeHead(204).end();
});
let upstreamPort = 0;
// Built at runtime: Sentry attaches source lines (ContextLines), so a literal would show up as code.
const SECRET = ['portal', 'key', 'value'].join('-');

describe('telemetry', () => {
  beforeAll(async () => {
    const port = await freePort();
    metricsUrl = `http://127.0.0.1:${port}/metrics`;
    telemetry = startTelemetry({
      service: 'api',
      release: 'abc123',
      environment: 'test',
      metrics: { host: '127.0.0.1', port },
    });
    initErrorReporting({
      dsn: 'https://public@o0.ingest.sentry.io/0',
      service: 'api',
      release: 'abc123',
      environment: 'test',
      transport: () => ({ send: async () => ({}), flush: async () => true }),
      beforeSend: (event) => {
        events.push(event);
        return null; // never leaves the process
      },
    });
    app = await createServer({
      logger: createLogger({ level: 'silent' }),
      trustProxy: false,
      openapi: { title: 't', version: '0' },
    });
    app.get('/things/:id', async () => ({ ok: true }));
    // Unique per request: Sentry's Dedupe drops an event identical to the previous one.
    app.get('/boom', async (request) => {
      throw new Error(`kaboom ${request.id}`);
    });
    app.get('/conflict', async () => {
      throw new AppError('VERSION_CONFLICT');
    });
    // A route that calls an upstream with a secret in the query string, then fails.
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as { port: number }).port;
    app.get('/calls-out', async (request) => {
      await fetch(`http://127.0.0.1:${upstreamPort}/portal?key=${SECRET}`);
      throw new Error(`after call ${request.id}`);
    });
    await app.ready();
  });
  afterAll(async () => {
    await new Promise((resolve) => upstream.close(resolve));
    await app.close();
    await flushErrors();
    await telemetry.shutdown();
  });

  it('[S0-10] metrics endpoint exposes request rate, error rate and latency histograms per route', async () => {
    for (const id of ['1', '2', '3']) await app.inject({ url: `/things/${id}` });
    await app.inject({ url: '/boom' });
    await app.inject({ url: '/nope/at/all' });

    const text = await (await fetch(metricsUrl)).text();
    const series = (route: string, status: number) =>
      text
        .split('\n')
        .filter(
          (l) =>
            l.startsWith('http_server_request_duration') &&
            l.includes(`http_route="${route}"`) &&
            l.includes(`http_response_status_code="${status}"`),
        );
    // Rate: one count per route template, not per URL.
    expect(series('/things/:id', 200).find((l) => l.startsWith('http_server_request_duration_count'))).toMatch(/ 3$/);
    // Errors: the 5xx series of the failing route.
    expect(series('/boom', 500).find((l) => l.startsWith('http_server_request_duration_count'))).toMatch(/ 1$/);
    // Latency: histogram buckets (le) per route, in seconds.
    expect(series('/things/:id', 200).filter((l) => l.includes('_bucket{') && l.includes('le="0.1"'))).toHaveLength(1);
    expect(series('unmatched', 404)).not.toHaveLength(0);
    expect(text).not.toContain('/nope/at/all');
  });

  it(
    '[S0-10] errors reach Sentry with release and request ID tags',
    async () => {
      events.length = 0;
      const res = await app.inject({
        url: '/boom?token=secret',
        headers: { authorization: 'Bearer x', cookie: 'a=b' },
      });
      expect(res.statusCode).toBe(500);
      const event = await eventFor(res.headers['x-request-id']);
      expect(event.release).toBe('abc123');
      expect(event.environment).toBe('test');
      expect(event.tags).toMatchObject({ requestId: res.headers['x-request-id'], route: '/boom', service: 'api' });
      expect(event.exception?.values?.[0]?.value).toBe(`kaboom ${res.headers['x-request-id']}`);
      expect(JSON.stringify(event)).not.toMatch(/token=secret|Bearer x|a=b/);
    },
    SENTRY_EVENT_MS,
  );

  it(
    '[S0-10] an outgoing call leaks no Sentry headers or baggage, and its query string stays out of the event',
    async () => {
      events.length = 0;
      const res = await app.inject({ url: '/calls-out', headers: { baggage: 'planted=1' } });
      expect(res.statusCode).toBe(500);
      const event = await eventFor(res.headers['x-request-id']);
      expect(upstreamHeaders).toBeDefined();
      expect(Object.keys(upstreamHeaders ?? {})).not.toContain('sentry-trace');
      expect(Object.keys(upstreamHeaders ?? {})).not.toContain('baggage');
      expect(JSON.stringify(event)).not.toContain(SECRET);
    },
    SENTRY_EVENT_MS,
  );

  it('[S0-10] expected failures (4xx AppErrors) are not reported', async () => {
    events.length = 0;
    expect((await app.inject({ url: '/conflict' })).statusCode).toBe(409);
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(0);
  });

  it('[S0-10] log lines inside a span carry its trace and span id', () => {
    const lines: Record<string, unknown>[] = [];
    const destination = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    const logger = createLogger({ destination });
    logger.info('outside');
    trace.getTracer('test').startActiveSpan('work', (span) => {
      logger.info('inside');
      span.end();
      const { traceId, spanId } = span.spanContext();
      expect(lines[1]).toMatchObject({ msg: 'inside', traceId, spanId });
    });
    expect(lines[0]).not.toHaveProperty('traceId');
  });

  it('[S0-10] exported spans carry no query strings, client addresses, job results or email addresses', () => {
    const span = {
      name: 'GET',
      attributes: {
        'url.full': 'https://x.test/reset?token=abc',
        'url.query': 'token=abc',
        'http.route': '/reset',
        'client.address': '203.0.113.9',
        'user_agent.original': 'curl/8',
        'bullmq.job.result': '{"link":"https://x.test/verify?token=abc"}',
        'bullmq.job.failed.reason': '550 <ana@example.com> rejected',
      },
      events: [{ name: 'exception', time: [0, 0], attributes: { 'exception.message': 'no user ana@example.com' } }],
      status: { code: 2, message: 'email: 550 <ana@example.com>' },
      spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
    };
    const clean = redactSpan(span as never);
    expect(clean.attributes).toEqual({
      'url.full': 'https://x.test/reset',
      'http.route': '/reset',
      'bullmq.job.failed.reason': '550 <[email]> rejected',
    });
    expect(clean.events[0]?.attributes).toEqual({ 'exception.message': 'no user [email]' });
    expect(clean.status.message).toBe('email: 550 <[email]>');
    expect(clean.spanContext().spanId).toBe('s');
    const named = redactSpan({ ...span, name: 'fetch GET https://x.test/reset?token=abc' } as never);
    expect(named.name).toBe('fetch GET https://x.test/reset');
    const untouched = { ...span, attributes: { 'http.route': '/x' }, events: [], status: { code: 0 } };
    expect(redactSpan(untouched as never)).toBe(untouched);
  });

  it('[S0-10] internet-facing apps re-sample a client-sent sampled traceparent by the ratio', () => {
    const remote = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: 'ffffffffffffffffffffffffffffffff',
      spanId: '1111111111111111',
      traceFlags: 1,
      isRemote: true,
    });
    const decide = (trustRemoteParent: boolean) =>
      samplerFor({ sampleRatio: 0, trustRemoteParent }).shouldSample(
        remote,
        'ffffffffffffffffffffffffffffffff',
        'GET /v1/me',
        SpanKind.SERVER,
        {},
        [],
      ).decision;
    expect(decide(false)).toBe(SamplingDecision.NOT_RECORD);
    expect(decide(true)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});
