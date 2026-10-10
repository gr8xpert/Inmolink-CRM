import type { Redis } from '@inmolink/platform/cache';
import type { Logger } from '@inmolink/platform/logger';
import { createServer, type FastifyZod, type HealthCheck, healthRoutes } from '@inmolink/platform/server';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';

/** Socket.io server for chat and notifications. Transport only — business logic lives in @inmolink/core. */
export const APP_NAME = 'realtime';

export interface RealtimeDeps {
  logger: Logger;
  trustProxy: false | number | string[];
  edgeRequestIdHeader?: string;
  checks: Record<string, HealthCheck>;
  /** Redis pub/sub for the adapter (sticky sessions + fan-out across nodes); omit for a single in-memory node in tests. */
  adapter?: { pub: Redis; sub: Redis };
}

export interface RealtimeApp {
  app: FastifyZod;
  io: Server;
  /**
   * Shutdown step: fail readiness, wait `delayMs` for the load balancer, disconnect sockets (clients
   * reconnect to another node), then drain HTTP.
   */
  drain(delayMs?: number): Promise<void>;
}

export async function buildApp(deps: RealtimeDeps): Promise<RealtimeApp> {
  const app = await createServer({
    logger: deps.logger,
    trustProxy: deps.trustProxy,
    edgeRequestIdHeader: deps.edgeRequestIdHeader,
    openapi: { title: 'Inmolink realtime', version: '2.0.0' },
  });
  healthRoutes(app, { checks: deps.checks });

  const io = new Server(app.server, {
    serveClient: false,
    transports: ['websocket', 'polling'],
    ...(deps.adapter ? { adapter: createAdapter(deps.adapter.pub, deps.adapter.sub) } : {}),
  });
  // Auth (short-lived JWT, same as api) and the /chat and /notifications namespaces arrive in S0-09 / S11.
  // Until then no client may connect, so nothing can join a room it does not belong to.
  io.use((_socket, next) => next(new Error('NOT_AUTHENTICATED')));

  return {
    app,
    io,
    async drain(delayMs = 0) {
      app.lifecycle.draining = true;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      io.disconnectSockets(true);
      app.lifecycle.closing = true;
      await app.close();
    },
  };
}
