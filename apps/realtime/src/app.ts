import { NotificationPush, REALTIME_NOTIFICATIONS_NAMESPACE } from '@inmolink/contracts';
import type { Redis, UserEvent } from '@inmolink/platform/cache';
import type { AccessTokenVerifier } from '@inmolink/platform/jwt';
import type { Logger } from '@inmolink/platform/logger';
import { createServer, type FastifyZod, type HealthCheck, healthRoutes } from '@inmolink/platform/server';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, type Socket } from 'socket.io';

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
  /**
   * S11-04: per-user events published by workers (redis-cache pub/sub, `subscribeUserEvents`); each goes to the
   * recipient's own sockets on this node. Returns the unsubscribe step. Omit to run without (tests use `deliver`).
   */
  userEvents?: (handler: (e: UserEvent) => void) => Promise<() => Promise<void>>;
}

/**
 * Namespaces that take per-user events, each with the schema its data must match; anything else a publisher sends is
 * dropped (a malformed or unexpected payload never reaches a browser).
 */
const USER_NAMESPACES = new Map<string, { safeParse(data: unknown): { success: boolean } }>([
  [REALTIME_NOTIFICATIONS_NAMESPACE, NotificationPush],
]);

/**
 * The Socket.io room of one user's sockets in one agency (server-side only: clients never join or name rooms). The
 * agency is the token's: a member of two agencies receives each one's notifications only on a socket opened for it.
 */
export const userRoom = (agencyId: string, userId: string) => `user:${agencyId}:${userId}`;

/** Clients send nothing but the handshake on these namespaces: a frame larger than this is refused. */
const MAX_CLIENT_FRAME_BYTES = 4_096;

export interface RealtimeApp {
  app: FastifyZod;
  io: Server;
  /** Emits a per-user event to that user's sockets on this node (what the pub/sub subscription calls). */
  deliver(e: UserEvent): void;
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
    maxHttpBufferSize: MAX_CLIENT_FRAME_BYTES,
    ...(deps.adapter ? { adapter: createAdapter(deps.adapter.pub, deps.adapter.sub) } : {}),
  });
  // Same short-lived JWT as the api (audience `realtime`), sent in the handshake `auth` payload — never
  // a cookie. Every namespace runs it: Socket.io middleware is per namespace (`io.use` covers `/` only).
  const authenticate = (socket: Socket, next: (err?: Error) => void) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    deps.verifier.verify(typeof token === 'string' ? token : '', 'realtime').then(
      (claims) => {
        socket.data.userId = claims.sub;
        socket.data.agencyId = claims.agency;
        socket.data.impersonated = claims.act !== undefined;
        socket.data.sessionVersion = claims.sv;
        // A socket outlives its token by at most this long: the client reconnects with a fresh one.
        const timer = setTimeout(() => socket.disconnect(true), Math.max(0, claims.exp * 1_000 - Date.now()));
        timer.unref();
        socket.once('disconnect', () => clearTimeout(timer));
        next();
      },
      () => next(new Error('NOT_AUTHENTICATED')),
    );
  };
  io.use(authenticate);

  // S11-04: `/notifications` — each socket joins its own user's room, nothing else; it sends nothing (reads and marks
  // go through the api). A user only ever receives events published for their own id. The /chat namespace is S11-03.
  // A member's feed needs the agency (`agency` claim); staff impersonating a member get no live feed (S1-09: they may
  // read it through the api, which checks the impersonation session on every request — a socket would outlive it).
  const notifications = io.of(REALTIME_NOTIFICATIONS_NAMESPACE);
  notifications.use(authenticate);
  notifications.use((socket, next) => {
    if (typeof socket.data.agencyId !== 'string') return next(new Error('NOT_AUTHENTICATED'));
    if (socket.data.impersonated) return next(new Error('FORBIDDEN'));
    next();
  });
  notifications.on('connection', (socket) => {
    void socket.join(userRoom(String(socket.data.agencyId), String(socket.data.userId)));
  });

  // Every node receives every publish (pub/sub): emit to this node's sockets only, so nothing is sent twice.
  const deliver = (e: UserEvent) => {
    const schema = USER_NAMESPACES.get(e.namespace);
    if (!schema?.safeParse(e.data).success) {
      deps.logger.warn({ namespace: e.namespace, event: e.event }, 'user event dropped');
      return;
    }
    io.of(e.namespace).local.to(userRoom(e.agencyId, e.userId)).emit(e.event, e.data);
  };
  const stopUserEvents = deps.userEvents ? await deps.userEvents(deliver) : undefined;

  return {
    app,
    io,
    deliver,
    async drain(delayMs = 0) {
      app.lifecycle.draining = true;
      await stopUserEvents?.();
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      io.disconnectSockets(true);
      app.lifecycle.closing = true;
      await app.close();
    },
  };
}
