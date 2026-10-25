import {
  type ChatAck,
  ChatMessagePush,
  ChatReadPush,
  ChatThreadRef,
  type ChatTypingPush,
  NotificationPush,
  REALTIME_CHAT_CLIENT_EVENTS,
  REALTIME_CHAT_EVENTS,
  REALTIME_CHAT_NAMESPACE,
  REALTIME_NOTIFICATION_EVENT,
  REALTIME_NOTIFICATIONS_NAMESPACE,
  REALTIME_SESSION_NAMESPACE,
  REALTIME_SESSION_REVOKED_EVENT,
  SessionRevokedPush,
} from '@inmolink/contracts';
import type { Redis, SessionRevocation, UserEvent } from '@inmolink/platform/cache';
import { ACCESS_TOKEN_TTL_SECONDS, type AccessTokenVerifier } from '@inmolink/platform/jwt';
import type { Logger } from '@inmolink/platform/logger';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
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
  userEvents?: (
    handler: (e: UserEvent) => void,
    /** S12-F4: whether this node has a socket of that member: other members' events are skipped unparsed. */
    isLocal: (agencyId: string, userId: string) => boolean,
  ) => Promise<() => Promise<void>>;
  /**
   * S11-03: whether this member (the socket's user, in the token's agency) takes part in the thread — the database's
   * answer (`chat.canJoinThread` under RLS). Errors count as no. Omit to refuse every `/chat` join.
   */
  canJoinThread?: (auth: { userId: string; agencyId: string }, threadId: string) => Promise<boolean>;
  /**
   * S11-03: a per-user counter across nodes (platform rate-limit on redis-limits): true when `identity` may go on.
   * Omit to count on this node only (tests).
   */
  limit?: (rule: RateLimitRule, identity: string) => Promise<boolean>;
  /**
   * S12-F10: the member's revocation shared by every node (redis-cache `markSessionRevoked`), checked on connect so a
   * restarted node or one that missed the pub/sub message still refuses an old token. Errors let the socket in (like
   * the limiter). Omit to rely on what this node heard (tests).
   */
  revocation?: (agencyId: string, userId: string) => Promise<SessionRevocation | null>;
}

type Schema = { safeParse(data: unknown): { success: boolean } };

/**
 * Namespaces that take per-user events, each event with the schema its data must match; anything else a publisher
 * sends is dropped (a malformed or unexpected payload never reaches a browser).
 */
const USER_NAMESPACES = new Map<string, ReadonlyMap<string, Schema>>([
  [REALTIME_NOTIFICATIONS_NAMESPACE, new Map([[REALTIME_NOTIFICATION_EVENT, NotificationPush]])],
  [
    REALTIME_CHAT_NAMESPACE,
    new Map<string, Schema>([
      [REALTIME_CHAT_EVENTS.message, ChatMessagePush],
      [REALTIME_CHAT_EVENTS.read, ChatReadPush],
    ]),
  ],
]);

/**
 * The Socket.io room of one user's sockets in one agency (server-side only: clients never join or name rooms). The
 * agency is the token's: a member of two agencies receives each one's notifications only on a socket opened for it.
 */
export const userRoom = (agencyId: string, userId: string) => `user:${agencyId}:${userId}`;

/**
 * The Socket.io room of one thread's joined sockets (both agencies' participants): typing only. Joined by the server
 * after the database said the socket's user takes part (`canJoinThread`), never by name from a client.
 */
export const threadRoom = (threadId: string) => `thread:${threadId}`;

/** Clients send only the handshake and small `/chat` frames (`{ threadId }`): a frame larger than this is refused. */
const MAX_CLIENT_FRAME_BYTES = 4_096;

/** `/chat` limits per socket: threads joined at once, join checks (database reads) and typing signals per minute. */
export const CHAT_SOCKET_LIMITS = { joined: 20, joinsPerMinute: 60, typingEveryMs: 1_500, socketsPerUser: 10 } as const;

/** Per user across nodes (`deps.limit`): `/chat` sockets opened and thread joins (each one a database read). */
export const CHAT_RATE_RULES = {
  connect: { name: 'realtime.chat.connect.user', scope: 'user', limit: 30, windowSeconds: 60 },
  join: { name: 'realtime.chat.join.user', scope: 'user', limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/** S12-F11: per user across nodes (`deps.limit`): `/notifications` sockets opened (same cap as `/chat`). */
export const NOTIFICATIONS_RATE_RULES = {
  connect: { name: 'realtime.notifications.connect.user', scope: 'user', limit: 30, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * S12-F10: revocations this node heard of (per member), kept as long as a token minted before them can live; the
 * oldest go first past this many (each entry is a few bytes; a burst of deactivations is far below it).
 */
const MAX_REVOCATIONS = 50_000;

/** S12-F10: a token issued up to this long after a deactivation (database time, node clocks differ) is refused too. */
const DEACTIVATION_SLACK_MS = 1_000;

interface Revocation extends SessionRevocation {
  /** Epoch ms after which a token issued before the revocation has expired anyway. */
  until: number;
}

/** S12-F10: whether this socket's token predates `r` (issued before the deactivation, or an older session version). */
function revokedBy(r: SessionRevocation, socket: Socket): boolean {
  if (r.deactivatedAt !== null && Number(socket.data.issuedAt) * 1_000 <= r.deactivatedAt + DEACTIVATION_SLACK_MS) {
    return true;
  }
  return r.sessionVersion !== null && Number(socket.data.sessionVersion) < r.sessionVersion;
}

export interface RealtimeApp {
  app: FastifyZod;
  io: Server;
  /** Emits a per-user event to that user's sockets on this node (what the pub/sub subscription calls). */
  deliver(e: UserEvent): void;
  /** S12-F4: whether this node has a socket of that member (the subscription skips other members' events). */
  isLocal(agencyId: string, userId: string): boolean;
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
        socket.data.issuedAt = claims.iat;
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

  // S12-F10: who was deactivated or had their sessions revoked (published by workers to every node): their open
  // sockets close, and the tokens minted before it cannot open new ones while they live.
  const revocations = new Map<string, Revocation>();
  const isRevoked = (socket: Socket): boolean => {
    const key = `${socket.data.agencyId}:${socket.data.userId}`;
    const r = revocations.get(key);
    if (!r) return false;
    if (r.until <= Date.now()) {
      revocations.delete(key);
      return false;
    }
    return revokedBy(r, socket);
  };
  const maxOf = (a: number | null, b: number | null | undefined) => (a === null ? (b ?? null) : Math.max(a, b ?? a));
  const revoke = (agencyId: string, userId: string, data: SessionRevokedPush) => {
    const key = `${agencyId}:${userId}`;
    const now = Date.now();
    const prev = revocations.get(key);
    const live = prev && prev.until > now ? prev : undefined;
    revocations.delete(key); // re-insert: the map's order is oldest first
    revocations.set(key, {
      deactivatedAt: maxOf(data.deactivatedAt === null ? null : Date.parse(data.deactivatedAt), live?.deactivatedAt),
      sessionVersion: maxOf(data.sessionVersion, live?.sessionVersion),
      until: now + ACCESS_TOKEN_TTL_SECONDS * 1_000,
    });
    let evictedLive = 0;
    while (revocations.size > MAX_REVOCATIONS) {
      const oldest = revocations.keys().next().value;
      if (oldest === undefined) break;
      if ((revocations.get(oldest)?.until ?? 0) > now) evictedLive += 1;
      revocations.delete(oldest);
    }
    // the shared copy in redis-cache (checked on connect) still holds them, unless evicted there too
    if (evictedLive > 0) deps.logger.warn({ evicted: evictedLive }, 'unexpired session revocations evicted');
    for (const nsp of [notifications, chat]) {
      for (const id of [...(nsp.adapter.rooms.get(userRoom(agencyId, userId)) ?? [])]) {
        const socket = nsp.sockets.get(id);
        if (socket && isRevoked(socket)) socket.disconnect(true);
      }
    }
  };

  /**
   * A user's sockets on a per-user namespace (`/notifications`, `/chat`): at most `socketsPerUser` tabs on this node
   * (sticky sessions keep a browser on one node), and `rule` counts connects per user across nodes (`deps.limit`;
   * a limiter error lets the socket in). Runs after `authenticate`, so the user and agency come from the token.
   */
  /** S12-F4: members with a connect waiting in `admit` (count per member). */
  const admitting = new Map<string, number>();
  const admit = (nsp: ReturnType<Server['of']>, rule: RateLimitRule, socket: Socket, next: (err?: Error) => void) => {
    if (isRevoked(socket)) return next(new Error('NOT_AUTHENTICATED'));
    const agencyId = String(socket.data.agencyId);
    const userId = String(socket.data.userId);
    const open = nsp.adapter.rooms.get(userRoom(agencyId, userId))?.size ?? 0;
    if (open >= CHAT_SOCKET_LIMITS.socketsPerUser) return next(new Error('RATE_LIMITED'));
    // S12-F4: while this connect waits on Redis the member counts as local, so a revocation published meanwhile is
    // not skipped (the socket is not in its room yet; `closeIfRevoked` checks again after the join)
    const member = `${agencyId}:${userId}`;
    admitting.set(member, (admitting.get(member) ?? 0) + 1);
    const admitted = (err?: Error) => {
      const left = (admitting.get(member) ?? 1) - 1;
      if (left > 0) admitting.set(member, left);
      else admitting.delete(member);
      next(err);
    };
    // both fail open: a Redis error lets the socket in
    const limited = deps.limit ? deps.limit(rule, `${agencyId}:${userId}`).catch(() => true) : Promise.resolve(true);
    // S12-F10: the revocation shared by every node (this node may have restarted or missed the message)
    const shared = deps.revocation ? deps.revocation(agencyId, userId).catch(() => null) : Promise.resolve(null);
    void Promise.all([limited, shared]).then(([allowed, r]) => {
      if (r && revokedBy(r, socket)) return admitted(new Error('NOT_AUTHENTICATED'));
      admitted(allowed ? undefined : new Error('RATE_LIMITED'));
    });
  };

  /** S12-F10: a revocation may arrive while `admit` waits on Redis, before the socket is in its room: check again. */
  const closeIfRevoked = (socket: Socket): boolean => {
    if (!isRevoked(socket)) return false;
    socket.disconnect(true);
    return true;
  };

  // S11-04: `/notifications` — each socket joins its own user's room, nothing else; it sends nothing (reads and marks
  // go through the api). A user only ever receives events published for their own id.
  // A member's feed needs the agency (`agency` claim); staff impersonating a member get no live feed (S1-09: they may
  // read it through the api, which checks the impersonation session on every request — a socket would outlive it).
  const notifications = io.of(REALTIME_NOTIFICATIONS_NAMESPACE);
  notifications.use(authenticate);
  notifications.use((socket, next) => {
    if (typeof socket.data.agencyId !== 'string') return next(new Error('NOT_AUTHENTICATED'));
    if (socket.data.impersonated) return next(new Error('FORBIDDEN'));
    admit(notifications, NOTIFICATIONS_RATE_RULES.connect, socket, next);
  });
  notifications.on('connection', (socket) => {
    void socket.join(userRoom(String(socket.data.agencyId), String(socket.data.userId)));
    closeIfRevoked(socket);
  });

  // S11-03: `/chat` — like `/notifications`, each socket joins its own user's room (messages and read receipts are
  // published per participant by the worker). For the typing indicator a client asks to `join` a thread: the server
  // checks in the database that the user takes part, then joins the thread's room. `typing` reaches the room's other
  // sockets only from a socket in it. Every client frame is validated; nothing a client sends is relayed as is.
  const chat = io.of(REALTIME_CHAT_NAMESPACE);
  chat.use(authenticate);
  chat.use((socket, next) => {
    if (typeof socket.data.agencyId !== 'string') return next(new Error('NOT_AUTHENTICATED'));
    if (socket.data.impersonated) return next(new Error('FORBIDDEN'));
    admit(chat, CHAT_RATE_RULES.connect, socket, next);
  });
  chat.on('connection', (socket) => {
    const agencyId = String(socket.data.agencyId);
    const userId = String(socket.data.userId);
    void socket.join(userRoom(agencyId, userId));
    if (closeIfRevoked(socket)) return;
    const joined = new Set<string>();
    const lastTyping = new Map<string, number>();
    let joinWindow = { start: Date.now(), count: 0 };
    const ack = (cb: unknown, answer: ChatAck) => {
      if (typeof cb === 'function') (cb as (a: ChatAck) => void)(answer);
    };

    socket.on(REALTIME_CHAT_CLIENT_EVENTS.join, (raw: unknown, cb?: unknown) => {
      const ref = ChatThreadRef.safeParse(raw);
      if (!ref.success) return ack(cb, { ok: false, error: 'VALIDATION_FAILED' });
      const { threadId } = ref.data;
      if (joined.has(threadId)) return ack(cb, { ok: true });
      const now = Date.now();
      if (now - joinWindow.start >= 60_000) joinWindow = { start: now, count: 0 };
      joinWindow.count += 1;
      if (joinWindow.count > CHAT_SOCKET_LIMITS.joinsPerMinute || joined.size >= CHAT_SOCKET_LIMITS.joined) {
        return ack(cb, { ok: false, error: 'RATE_LIMITED' });
      }
      const check = deps.canJoinThread ?? (async () => false);
      const limited = deps.limit ? deps.limit(CHAT_RATE_RULES.join, `${agencyId}:${userId}`) : Promise.resolve(true);
      limited
        .then(
          (allowed): Promise<boolean | 'limited'> =>
            allowed ? check({ userId, agencyId }, threadId) : Promise.resolve('limited'),
        )
        .then(
          (allowed: boolean | 'limited') => {
            if (allowed === 'limited') return ack(cb, { ok: false, error: 'RATE_LIMITED' });
            if (!allowed || socket.disconnected) return ack(cb, { ok: false, error: 'FORBIDDEN' });
            joined.add(threadId);
            void socket.join(threadRoom(threadId));
            ack(cb, { ok: true });
          },
          (err: unknown) => {
            deps.logger.warn({ err, threadId }, 'chat join check failed');
            ack(cb, { ok: false, error: 'FORBIDDEN' });
          },
        );
    });

    socket.on(REALTIME_CHAT_CLIENT_EVENTS.leave, (raw: unknown, cb?: unknown) => {
      const ref = ChatThreadRef.safeParse(raw);
      if (!ref.success) return ack(cb, { ok: false, error: 'VALIDATION_FAILED' });
      joined.delete(ref.data.threadId);
      lastTyping.delete(ref.data.threadId);
      void socket.leave(threadRoom(ref.data.threadId));
      ack(cb, { ok: true });
    });

    socket.on(REALTIME_CHAT_CLIENT_EVENTS.typing, (raw: unknown, cb?: unknown) => {
      const ref = ChatThreadRef.safeParse(raw);
      if (!ref.success) return ack(cb, { ok: false, error: 'VALIDATION_FAILED' });
      const { threadId } = ref.data;
      if (!joined.has(threadId)) return ack(cb, { ok: false, error: 'FORBIDDEN' });
      const now = Date.now();
      if (now - (lastTyping.get(threadId) ?? 0) < CHAT_SOCKET_LIMITS.typingEveryMs) return ack(cb, { ok: true });
      lastTyping.set(threadId, now);
      const data: ChatTypingPush = { threadId, agencyId, userId };
      // across nodes through the adapter; never back to the typist's own socket
      socket.to(threadRoom(threadId)).emit(REALTIME_CHAT_EVENTS.typing, data);
      ack(cb, { ok: true });
    });
  });

  // Every node receives every publish (pub/sub): emit to this node's sockets only, so nothing is sent twice.
  const deliver = (e: UserEvent) => {
    if (e.namespace === REALTIME_SESSION_NAMESPACE) {
      const parsed = e.event === REALTIME_SESSION_REVOKED_EVENT ? SessionRevokedPush.safeParse(e.data) : undefined;
      if (!parsed?.success) {
        deps.logger.warn({ namespace: e.namespace, event: e.event }, 'user event dropped');
        return;
      }
      revoke(e.agencyId, e.userId, parsed.data);
      return;
    }
    const schema = USER_NAMESPACES.get(e.namespace)?.get(e.event);
    if (!schema?.safeParse(e.data).success) {
      deps.logger.warn({ namespace: e.namespace, event: e.event }, 'user event dropped');
      return;
    }
    io.of(e.namespace).local.to(userRoom(e.agencyId, e.userId)).emit(e.event, e.data);
  };
  // S12-F4: a member is local when one of their sockets is in their room on a per-user namespace of this node, or a
  // connect of theirs waits in `admit`. Revocations go to every node unprefixed (S12-F10, `everyNode`), so each node
  // records them whether or not it holds a socket of the member; redis-cache's copy is the second layer.
  const isLocal = (agencyId: string, userId: string) => {
    const room = userRoom(agencyId, userId);
    return (
      notifications.adapter.rooms.has(room) || chat.adapter.rooms.has(room) || admitting.has(`${agencyId}:${userId}`)
    );
  };
  const stopUserEvents = deps.userEvents ? await deps.userEvents(deliver, isLocal) : undefined;

  return {
    app,
    io,
    deliver,
    isLocal, // S12-F4
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
