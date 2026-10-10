/**
 * @inmolink/platform/server — Fastify plumbing shared by api, feed-api, realtime and the worker's
 * health server (S0-08): `createServer`, health routes, error mapping, graceful shutdown.
 */
export { createServer, type FastifyZod, type Lifecycle, type ServerOptions } from './create';
export { errorBody, errorHandler, sendError } from './errors';
export { type HealthCheck, type HealthOptions, healthRoutes, httpCheck, redisCheck } from './health';
export { gracefulShutdown, type Shutdown, type ShutdownOptions, type ShutdownStep } from './shutdown';

import type { FastifyZod } from './create';

/**
 * Graceful-shutdown step for an HTTP app: fail readiness, keep serving for `delayMs` so the load
 * balancer can route away (`SHUTDOWN_DRAIN_DELAY_MS`), then refuse new requests and wait for in-flight ones.
 */
export function drainHttp(app: FastifyZod, delayMs = 0) {
  return {
    name: 'http',
    run: async () => {
      app.lifecycle.draining = true;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      app.lifecycle.closing = true;
      await app.close();
    },
  };
}
