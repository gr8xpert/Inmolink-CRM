import { HealthBody } from '@inmolink/contracts';
import type { Redis } from 'ioredis';
import { whenReady } from '../cache/ready';
import type {} from '../rate-limit/fastify';
import type { FastifyZod } from './create';

/** Resolves when the dependency is usable; throws (or times out) otherwise. */
export type HealthCheck = () => Promise<void>;

export interface HealthOptions {
  /** Readiness dependencies, e.g. `{ db, redisCache, search }`. */
  checks: Record<string, HealthCheck>;
  /** Per check; a hung dependency (PgBouncer waiting on a dead Postgres) fails instead of hanging. */
  timeoutMs?: number;
  /** How long one readiness result is reused (default 1 s; 0 in tests that change dependencies). */
  cacheMs?: number;
}

function withTimeout(check: HealthCheck, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([check(), timeout]).finally(() => clearTimeout(timer));
}

type Readiness = { ok: boolean; checks: Record<string, 'ok' | 'fail'> };

/**
 * `/healthz` — liveness: the process answers (no dependency checks, so a database outage does not
 * get every app node restarted). `/readyz` — readiness: every dependency answers within the timeout,
 * and the app is not draining. Failure reasons are logged, never returned (the endpoint is public).
 *
 * `/readyz` is not rate limited (orchestrators poll it), so it must stay cheap under a flood: one run
 * of the checks at a time, and its result is reused for `cacheMs`. A hung dependency therefore holds
 * at most one pool connection, however many probes arrive.
 */
export function healthRoutes(app: FastifyZod, options: HealthOptions): void {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const cacheMs = options.cacheMs ?? 1_000;
  const entries = Object.entries(options.checks);
  const common = { config: { rateLimit: false as const }, logLevel: 'warn' as const };
  let inFlight: Promise<Readiness> | undefined;
  let last: { at: number; result: Readiness } | undefined;

  const runChecks = async (): Promise<Readiness> => {
    const results = await Promise.allSettled(entries.map(([, check]) => withTimeout(check, timeoutMs)));
    const checks: Record<string, 'ok' | 'fail'> = {};
    results.forEach((result, i) => {
      const name = entries[i]?.[0] ?? String(i);
      checks[name] = result.status === 'fulfilled' ? 'ok' : 'fail';
      if (result.status === 'rejected') app.log.warn({ check: name, err: result.reason }, 'readiness check failed');
    });
    return { ok: results.every((r) => r.status === 'fulfilled'), checks };
  };

  const readiness = (): Promise<Readiness> => {
    if (last && Date.now() - last.at < cacheMs) return Promise.resolve(last.result);
    inFlight ??= runChecks()
      .then((result) => {
        last = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  app.get(
    '/healthz',
    {
      ...common,
      schema: { tags: ['ops'], operationId: 'ops.liveness', summary: 'Liveness', response: { 200: HealthBody } },
    },
    async (_request, reply) => reply.header('cache-control', 'no-store').send({ status: 'ok' as const }),
  );

  app.get(
    '/readyz',
    {
      ...common,
      schema: {
        tags: ['ops'],
        operationId: 'ops.readiness',
        summary: 'Readiness (database, Redis, search)',
        response: { 200: HealthBody, 503: HealthBody },
      },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      if (app.lifecycle.draining) return reply.code(503).send({ status: 'draining' as const });
      const { ok, checks } = await readiness();
      return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'fail', checks });
    },
  );
}

/** PING on an ioredis connection (redis-cache, redis-queue, the realtime adapter). */
export const redisCheck =
  (redis: () => Redis): HealthCheck =>
  async () => {
    const conn = redis();
    await whenReady(conn); // a connection without an offline queue rejects commands until its first connect
    await conn.ping();
  };

/** GET on an internal health URL (Meilisearch `/health`). Not for user-supplied URLs — those use safeFetch. */
export const httpCheck =
  (url: string, timeoutMs = 2_000): HealthCheck =>
  async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  };
