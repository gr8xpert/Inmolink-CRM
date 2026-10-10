import type { Redis } from '@inmolink/platform/cache';
import type { AccessTokenVerifier } from '@inmolink/platform/jwt';
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
  /** Access tokens from the web app (audience `realtime`). */
  verifier: AccessTokenVerifier;
  /** Exact origins allowed to open a socket (`WEB_URL`). */
  allowedOrigins: readonly string[];
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

  const allowed = new Set(deps.allowedOrigins);
  const io = new Server(app.server, {
    serveClient: false,
    transports: ['websocket', 'polling'],
    // Engine.io traffic bypasses Fastify hooks, so the origin check lives here: only the dashboard's
    // origins may open a socket (browsers always send Origin; requests without one are refused).
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, typeof origin === 'string' && allowed.has(origin));
    },
    cors: { origin: [...allowed], credentials: false },
    ...(deps.adapter ? { adapter: createAdapter(deps.adapter.pub, deps.adapter.sub) } : {}),
  });
  // Same short-lived JWT as the api (audience `realtime`), sent in the handshake `auth` payload — never
  // a cookie. The /chat and /notifications namespaces and their rooms arrive in S11.
  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    deps.verifier.verify(typeof token === 'string' ? token : '', 'realtime').then(
      (claims) => {
        socket.data.userId = claims.sub;
        socket.data.sessionVersion = claims.sv;
        // A socket outlives its token by at most this long: the client reconnects with a fresh one.
        const timer = setTimeout(() => socket.disconnect(true), Math.max(0, claims.exp * 1_000 - Date.now()));
        timer.unref();
        socket.once('disconnect', () => clearTimeout(timer));
        next();
      },
      () => next(new Error('NOT_AUTHENTICATED')),
    );
  });

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
