import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { httpEnv, loadConfig } from '../config';
import { AppError } from '../errors';
import { createLogger } from '../logger';
import { createServer, drainHttp, type FastifyZod, gracefulShutdown, healthRoutes } from './index';

const logger = createLogger({ level: 'silent' });
const opened: FastifyZod[] = [];

async function server(options: { edgeRequestIdHeader?: string } = {}): Promise<FastifyZod> {
  const app = await createServer({ logger, trustProxy: false, openapi: { title: 't', version: '1' }, ...options });
  opened.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

/** A service function, as a route handler would call it. */
async function updateListing(_input: { version: number }): Promise<never> {
  throw new AppError('VERSION_CONFLICT', { currentVersion: 3 });
}

describe('error mapping', () => {
  it('[S0-08] AppError(VERSION_CONFLICT) thrown in a service returns 409 with the standard error body', async () => {
    const app = await server();
    app.patch('/listings/:id', { schema: { body: z.object({ version: z.number().int() }) } }, (req) =>
      updateListing(req.body),
    );
    const res = await app.inject({ method: 'PATCH', url: '/listings/1', payload: { version: 2 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'VERSION_CONFLICT', message: 'Conflict', details: { currentVersion: 3 } },
    });
  });

  it('[S0-08] request schema failures return 422 VALIDATION_FAILED with the failing paths', async () => {
    const app = await server();
    app.post('/x', { schema: { body: z.object({ name: z.string() }).strict() } }, async () => ({ ok: true }));
    const res = await app.inject({ method: 'POST', url: '/x', payload: { name: 1 } });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.in).toBe('body');
    expect(body.error.details.issues[0].path).toBe('/name');
  });

  it('[S0-08] unknown errors return 500 INTERNAL without internals', async () => {
    const app = await server();
    app.get('/boom', async () => {
      throw new Error('connection string postgres://secret@db');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal Server Error' } });
  });

  it('[S0-08] a response that breaks its schema is a 500, not a leak', async () => {
    const app = await server();
    app.get('/leak', { schema: { response: { 200: z.object({ id: z.string() }) } } }, async () => ({ id: 1 }) as never);
    const res = await app.inject({ method: 'GET', url: '/leak' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
  });

  it('[S0-08] framework errors use the standard body (404, bad JSON, body too large)', async () => {
    const app = await createServer({ logger, trustProxy: false, openapi: { title: 't', version: '1' }, bodyLimit: 64 });
    opened.push(app);
    app.post('/echo', async (req) => req.body);
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not Found' } });
    const bad = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BAD_REQUEST');
    const big = await app.inject({ method: 'POST', url: '/echo', payload: { x: 'y'.repeat(200) } });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('request ids', () => {
  it('[S0-08] generates an id per request and ignores a client-sent x-request-id', async () => {
    const app = await server();
    app.get('/id', async (req) => ({ id: req.id }));
    const res = await app.inject({ method: 'GET', url: '/id', headers: { 'x-request-id': 'client-chosen-id-123' } });
    expect(res.json().id).not.toBe('client-chosen-id-123');
    expect(res.headers['x-request-id']).toBe(res.json().id);
  });

  it('[S0-08] keeps a well-formed id from the trusted edge header only', async () => {
    const app = await server({ edgeRequestIdHeader: 'cf-ray' });
    app.get('/id', async (req) => ({ id: req.id }));
    const ok = await app.inject({ method: 'GET', url: '/id', headers: { 'cf-ray': '8a1b2c3d4e5f-MAD' } });
    expect(ok.json().id).toBe('8a1b2c3d4e5f-MAD');
    const bad = await app.inject({ method: 'GET', url: '/id', headers: { 'cf-ray': 'x y\n' } });
    expect(bad.json().id).not.toBe('x y\n');
  });
});

describe('health', () => {
  it('[S0-08] /healthz is liveness only; /readyz reports each dependency', async () => {
    const app = await server();
    healthRoutes(app, {
      checks: { db: async () => {}, search: async () => Promise.reject(new Error('down')) },
    });
    const live = await app.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'fail', checks: { db: 'ok', search: 'fail' } });
  });

  it('[S0-08] a hung dependency fails readiness after the timeout', async () => {
    const app = await server();
    healthRoutes(app, { checks: { db: () => new Promise(() => {}) }, timeoutMs: 50, cacheMs: 0 });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ db: 'fail' });
  });

  it('[S0-08] /readyz runs one check at a time and reuses the result briefly (flood-safe)', async () => {
    const app = await server();
    let runs = 0;
    healthRoutes(app, {
      checks: {
        db: async () => {
          runs++;
          await new Promise((r) => setTimeout(r, 50));
        },
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/readyz' })),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses[0]?.headers['cache-control']).toBe('no-store');
    await app.inject({ method: 'GET', url: '/readyz' });
    expect(runs).toBe(1);
  });

  it('[S0-08] the OpenAPI document lists the routes', async () => {
    const app = await server();
    healthRoutes(app, { checks: {} });
    await app.ready();
    const spec = app.swagger() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/healthz', '/readyz']));
  });
});

describe('graceful shutdown', () => {
  it('[S0-08] SIGTERM drains in-flight requests within 30 s', async () => {
    const app = await server();
    healthRoutes(app, { checks: {} });
    let release!: () => void;
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => {
      entered = r;
    });
    app.get('/slow', async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return { done: true };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const exit = vi.fn();
    const shutdown = gracefulShutdown({ logger, steps: [drainHttp(app)], signals: ['SIGTERM'], exit });
    try {
      const slow = fetch(`${base}/slow`);
      await inHandler;
      const started = Date.now();
      process.emit('SIGTERM');
      expect(app.lifecycle.draining).toBe(true);

      setTimeout(() => release(), 100);
      const res = await slow;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ done: true });
      await shutdown.shutdown('SIGTERM'); // same run as the signal's
      expect(exit).toHaveBeenCalledWith(0);
      expect(app.server.listening).toBe(false);
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      release?.();
      shutdown.dispose();
    }
  });

  it('[S0-08] while closing, /readyz fails and new requests get 503 SERVICE_UNAVAILABLE', async () => {
    const app = await server();
    healthRoutes(app, { checks: {} });
    app.get('/work', async () => ({ ok: true }));
    app.lifecycle.draining = true;
    app.lifecycle.closing = true;
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'draining' });
    const refused = await app.inject({ method: 'GET', url: '/work' });
    expect(refused.statusCode).toBe(503);
    expect(refused.headers.connection).toBe('close');
    expect(refused.json().error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('[S0-08] exits 1 when a step outlives the deadline', async () => {
    const exit = vi.fn();
    const shutdown = gracefulShutdown({
      logger,
      signals: [],
      exit,
      timeoutMs: 50,
      steps: [{ name: 'stuck', run: () => new Promise(() => {}) }],
    });
    void shutdown.shutdown('test');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('[S0-08] a failing step does not stop the others', async () => {
    const exit = vi.fn();
    const ran: string[] = [];
    const shutdown = gracefulShutdown({
      logger,
      signals: [],
      exit,
      steps: [
        { name: 'a', run: async () => Promise.reject(new Error('x')) },
        { name: 'b', run: async () => void ran.push('b') },
      ],
    });
    await shutdown.shutdown('test');
    expect(ran).toEqual(['b']);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('httpEnv', () => {
  const load = (TRUST_PROXY?: string) => loadConfig(httpEnv, { TRUST_PROXY });

  it('[S0-08] TRUST_PROXY takes a hop count or CIDRs, never true', () => {
    expect(load().TRUST_PROXY).toBe(false);
    expect(load('1').TRUST_PROXY).toBe(1);
    expect(load('10.0.0.0/8, loopback').TRUST_PROXY).toEqual(['10.0.0.0/8', 'loopback']);
    expect(() => load('true')).toThrow(/never true/);
    expect(() => load('*')).toThrow(/never true/);
  });

  it('[S0-08] TRUST_PROXY refuses catch-all ranges and large hop counts (same effect as true)', () => {
    for (const value of [
      '0.0.0.0/0',
      '::/0',
      '0.0.0.0/0,::/0',
      '10.0.0.0/7',
      '2001:db8::/15',
      '999.1.1.1',
      '1.2.3.4/33',
    ]) {
      expect(() => load(value), value).toThrow(/never true/);
    }
    expect(() => load('99')).toThrow(/at most 3/);
    expect(load('3').TRUST_PROXY).toBe(3);
    expect(load('10.0.0.0/8,2001:db8::/32,192.168.1.10').TRUST_PROXY).toEqual([
      '10.0.0.0/8',
      '2001:db8::/32',
      '192.168.1.10',
    ]);
  });
});
