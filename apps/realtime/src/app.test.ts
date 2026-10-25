import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  encodeUserEvent,
  type Redis,
  type SessionRevocation,
  subscribeUserEvents,
  USER_EVENTS_CHANNEL,
  type UserEvent,
} from '@inmolink/platform/cache';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, NOTIFICATIONS_RATE_RULES, type RealtimeApp } from './app';

const USER = '0192a0b4-0000-7000-8000-000000000001';
const OTHER_USER = '0192a0b4-0000-7000-8000-000000000002';
const AGENCY = '0192a0b4-0000-7000-8000-0000000000a1';
const OTHER_AGENCY = '0192a0b4-0000-7000-8000-0000000000a2';
const NOTIFICATION = '0192a0b4-0000-7000-8000-0000000000f1';
const STAFF = '0192a0b4-0000-7000-8000-0000000000b1';
const SESSION = '0192a0b4-0000-7000-8000-0000000000c1';
const ORIGIN = 'http://localhost:3100';
const THREAD = '0192a0b4-0000-7000-8000-0000000000d1';
const STRANGER = '0192a0b4-0000-7000-8000-000000000003';
/** S11-03: who the database says takes part in which thread (USER and OTHER_USER of AGENCY in THREAD). */
const PARTICIPANTS = new Set([`${AGENCY}:${USER}:${THREAD}`, `${AGENCY}:${OTHER_USER}:${THREAD}`]);
const joinChecks: string[] = [];
/** S11-03: the per-user Redis counters (`deps.limit`), faked: LIMITED is over its join limit. */
const LIMITED = '0192a0b4-0000-7000-8000-000000000004';
const limited: string[] = [];
/** S12-F11: a user whose `/notifications` connects the fake limiter counts (one window, `rule.limit` per window). */
const CONNECTOR = '0192a0b4-0000-7000-8000-000000000005';
/** S12-F10: a member who gets deactivated, and one whose sessions are revoked. */
const DEACTIVATED = '0192a0b4-0000-7000-8000-000000000006';
const RESET = '0192a0b4-0000-7000-8000-000000000007';
/** S12-F10: revocations in the shared store (`deps.revocation`), one member whose lookup fails, one held in `limit`. */
const SHARED = '0192a0b4-0000-7000-8000-000000000008';
const SHARED_DOWN = '0192a0b4-0000-7000-8000-000000000009';
const RACER = '0192a0b4-0000-7000-8000-00000000000a';
const sharedRevocations = new Map<string, SessionRevocation>();
let releaseRacer: (() => void) | undefined;
let racerWaiting: (() => void) | undefined;
let connects = 0;
const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 'k1' });

let realtime: RealtimeApp;
let url = '';
/** The pub/sub subscription's handler (what `subscribeUserEvents` would call), and whether drain stopped it. */
let publish: ((e: UserEvent) => void) | undefined;
let unsubscribed = false;

beforeAll(async () => {
  realtime = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    checks: { redis: async () => {} },
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(`k1:${pair.publicKey}`) }),
    allowedOrigins: [ORIGIN],
    canJoinThread: async ({ userId, agencyId }, threadId) => {
      joinChecks.push(`${agencyId}:${userId}:${threadId}`);
      return PARTICIPANTS.has(`${agencyId}:${userId}:${threadId}`);
    },
    limit: async (rule, identity) => {
      limited.push(`${rule.name}:${identity}`);
      if (rule.name === 'realtime.notifications.connect.user' && identity.endsWith(CONNECTOR)) {
        // S12-F11: a fixed window that never rolls over within the test: the (limit + 1)th connect is refused
        connects += 1;
        return connects <= rule.limit;
      }
      if (identity.endsWith(RACER)) {
        // S12-F10: held until the test has published a revocation
        await new Promise<void>((resolve) => {
          releaseRacer = resolve;
          racerWaiting?.();
        });
      }
      return !(rule.name === 'realtime.chat.join.user' && identity.endsWith(LIMITED));
    },
    revocation: async (agencyId, userId) => {
      if (userId === SHARED_DOWN) throw new Error('redis-cache down');
      return sharedRevocations.get(`${agencyId}:${userId}`) ?? null;
    },
    // S12-F4: the real subscription on a stand-in connection: every publish is encoded with its prefix and skipped
    // unparsed unless the member is local to this node (`isLocal`), as in production
    userEvents: async (handler, isLocal) => {
      const sub = Object.assign(new EventEmitter(), {
        subscribe: async () => 1,
        unsubscribe: async () => 0,
      }) as unknown as Redis;
      const stop = await subscribeUserEvents(sub, handler, createLogger({ level: 'silent' }), { isLocal });
      publish = (e) => sub.emit('message', USER_EVENTS_CHANNEL, encodeUserEvent(e));
      return async () => {
        await stop();
        unsubscribed = true;
      };
    },
  });
  await realtime.app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(realtime.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await realtime.drain();
  expect(realtime.app.server.listening).toBe(false);
  expect(unsubscribed).toBe(true);
});

/** Resolves 'connected' or the connect_error message. */
function attempt(options: { token?: string; origin?: string }): Promise<string> {
  const socket = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    auth: options.token ? { token: options.token } : {},
    extraHeaders: options.origin ? { origin: options.origin } : {},
  });
  return new Promise<string>((resolve) => {
    socket.on('connect', () => resolve('connected'));
    socket.on('connect_error', (err) => resolve(err.message));
  }).finally(() => socket.close());
}

interface Claims {
  agency?: string;
  act?: string;
  imp?: string;
}

/** A connected socket on `namespace` as `userId` (with these claims), or the connect_error message. */
function open(namespace: string, userId?: string, claims: Claims = { agency: AGENCY }): Promise<Socket | string> {
  return (
    userId ? signer.sign({ sub: userId, aud: 'realtime', sv: 1, ...claims }) : Promise.resolve({ token: '' })
  ).then(
    ({ token }) =>
      new Promise<Socket | string>((resolve) => {
        const socket = connect(`${url}${namespace}`, {
          transports: ['websocket'],
          reconnection: false,
          auth: token ? { token } : {},
          extraHeaders: { origin: ORIGIN },
        });
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', (err) => {
          socket.close();
          resolve(err.message);
        });
      }),
  );
}

/** What `socket` receives as `event` within `ms`. */
function received(socket: Socket, event: string, ms = 300): Promise<unknown[]> {
  const got: unknown[] = [];
  socket.on(event, (data: unknown) => got.push(data));
  return new Promise((resolve) => setTimeout(() => resolve(got), ms));
}

/** A valid `NotificationPush` for `agencyId`. */
const push = (agencyId: string) => ({
  agencyId,
  notification: {
    id: NOTIFICATION,
    type: 'CHAT_MESSAGE',
    params: { subject: 'Villa' },
    link: null,
    actorUserId: null,
    readAt: null,
    createdAt: '2026-10-24T10:00:00.000Z',
  },
});

function connected<T extends (Socket | string)[]>(...sockets: T): { [K in keyof T]: Socket } {
  for (const s of sockets) if (typeof s === 'string') throw new Error(`socket did not connect: ${s}`);
  return sockets as { [K in keyof T]: Socket };
}

describe('realtime app', () => {
  it('[S0-08] realtime boots with health routes', async () => {
    expect((await realtime.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });

  it('[S0-09] a socket from the dashboard origin with a realtime token connects', async () => {
    const { token } = await signer.sign({ sub: USER, aud: 'realtime', sv: 1 });
    expect(await attempt({ token, origin: ORIGIN })).toBe('connected');
  });

  it('[S0-09] a missing token or an api-audience token is refused with NOT_AUTHENTICATED', async () => {
    expect(await attempt({ origin: ORIGIN })).toBe('NOT_AUTHENTICATED');
    const { token } = await signer.sign({ sub: USER, aud: 'api', sv: 1 });
    expect(await attempt({ token, origin: ORIGIN })).toBe('NOT_AUTHENTICATED');
  });

  it('[S0-09] other origins, or no origin, cannot open a socket even with a valid token', async () => {
    const { token } = await signer.sign({ sub: USER, aud: 'realtime', sv: 1 });
    expect(await attempt({ token, origin: 'https://evil.example' })).not.toBe('connected');
    expect(await attempt({ token })).not.toBe('connected');
  });

  it('[S11-04] /notifications refuses a socket without a valid token, without an agency, or impersonating', async () => {
    expect(await open('/notifications')).toBe('NOT_AUTHENTICATED');
    expect(await open('/notifications', USER, {})).toBe('NOT_AUTHENTICATED');
    expect(await open('/notifications', USER, { agency: AGENCY, act: STAFF, imp: SESSION })).toBe('FORBIDDEN');
  });

  it('[S11-04] a user only receives their own notifications of that agency, once per publish, on /notifications only', async () => {
    const [mine, theirs, otherAgency, main] = connected(
      await open('/notifications', USER),
      await open('/notifications', OTHER_USER),
      await open('/notifications', USER, { agency: OTHER_AGENCY }),
      await open('/', USER),
    );
    try {
      const got = [mine, theirs, otherAgency, main].map((s) => received(s, 'notification'));
      const data = push(AGENCY);
      publish?.({ userId: USER, agencyId: AGENCY, namespace: '/notifications', event: 'notification', data });
      // a namespace the server does not serve per user, or data that is not a NotificationPush, is dropped
      publish?.({ userId: USER, agencyId: AGENCY, namespace: '/chat', event: 'notification', data });
      realtime.deliver({
        userId: USER,
        agencyId: AGENCY,
        namespace: '/notifications',
        event: 'notification',
        data: { x: 1 },
      });
      const [gotMine, gotTheirs, gotOtherAgency, gotMain] = await Promise.all(got);
      expect(gotMine).toEqual([data]);
      expect(gotTheirs).toEqual([]);
      expect(gotOtherAgency).toEqual([]);
      expect(gotMain).toEqual([]);
    } finally {
      for (const s of [mine, theirs, otherAgency, main]) s.close();
    }
  });

  it('[S11-04] a socket cannot join another user’s room: client events are ignored', async () => {
    const [theirs] = connected(await open('/notifications', OTHER_USER));
    try {
      theirs.emit('join', `user:${AGENCY}:${USER}`);
      const got = received(theirs, 'notification');
      realtime.deliver({
        userId: USER,
        agencyId: AGENCY,
        namespace: '/notifications',
        event: 'notification',
        data: push(AGENCY),
      });
      expect(await got).toEqual([]);
    } finally {
      theirs.close();
    }
  });

  /** `socket`'s ack for `event` with `data`. */
  const ask = (socket: Socket, event: string, data: unknown) =>
    new Promise<unknown>((resolve) => socket.emit(event, data, (a: unknown) => resolve(a)));

  it('[S11-03] /chat refuses a socket without a valid token, without an agency, or impersonating', async () => {
    expect(await open('/chat')).toBe('NOT_AUTHENTICATED');
    expect(await open('/chat', USER, {})).toBe('NOT_AUTHENTICATED');
    expect(await open('/chat', USER, { agency: AGENCY, act: STAFF, imp: SESSION })).toBe('FORBIDDEN');
  });

  it('[S11-03] users cannot join a thread they are not part of: the join is refused and typing neither reaches nor leaves them', async () => {
    const [mine, colleague, stranger, otherAgency] = connected(
      await open('/chat', USER),
      await open('/chat', OTHER_USER),
      await open('/chat', STRANGER),
      await open('/chat', USER, { agency: OTHER_AGENCY }),
    );
    try {
      joinChecks.length = 0;
      expect(await ask(mine, 'join', { threadId: THREAD })).toEqual({ ok: true });
      expect(await ask(colleague, 'join', { threadId: THREAD })).toEqual({ ok: true });
      // not a participant (the database says no), nor the same user in another agency: refused
      expect(await ask(stranger, 'join', { threadId: THREAD })).toEqual({ ok: false, error: 'FORBIDDEN' });
      expect(await ask(otherAgency, 'join', { threadId: THREAD })).toEqual({ ok: false, error: 'FORBIDDEN' });
      // the check asks for the socket's own user and agency (from the token), whatever the client sends
      expect(await ask(stranger, 'join', { threadId: THREAD, userId: USER })).toEqual({
        ok: false,
        error: 'VALIDATION_FAILED',
      });
      expect(await ask(stranger, 'join', `thread:${THREAD}`)).toEqual({ ok: false, error: 'VALIDATION_FAILED' });
      expect(joinChecks.sort()).toEqual(
        [
          `${AGENCY}:${USER}:${THREAD}`,
          `${AGENCY}:${OTHER_USER}:${THREAD}`,
          `${AGENCY}:${STRANGER}:${THREAD}`,
          `${OTHER_AGENCY}:${USER}:${THREAD}`,
        ].sort(),
      );

      const got = [mine, colleague, stranger, otherAgency].map((s) => received(s, 'typing'));
      // a socket outside the thread cannot type into it
      expect(await ask(stranger, 'typing', { threadId: THREAD })).toEqual({ ok: false, error: 'FORBIDDEN' });
      expect(await ask(mine, 'typing', { threadId: THREAD })).toEqual({ ok: true });
      const [gotMine, gotColleague, gotStranger, gotOther] = await Promise.all(got);
      expect(gotColleague).toEqual([{ threadId: THREAD, agencyId: AGENCY, userId: USER }]);
      expect(gotMine).toEqual([]);
      expect(gotStranger).toEqual([]);
      expect(gotOther).toEqual([]);

      // after leaving, typing is refused
      expect(await ask(colleague, 'leave', { threadId: THREAD })).toEqual({ ok: true });
      expect(await ask(colleague, 'typing', { threadId: THREAD })).toEqual({ ok: false, error: 'FORBIDDEN' });
    } finally {
      for (const s of [mine, colleague, stranger, otherAgency]) s.close();
    }
  });

  it('[S11-03] chat messages reach only their recipient’s sockets on /chat; malformed or unknown events are dropped', async () => {
    const [mine, theirs, otherAgency, notif] = connected(
      await open('/chat', USER),
      await open('/chat', OTHER_USER),
      await open('/chat', USER, { agency: OTHER_AGENCY }),
      await open('/notifications', USER),
    );
    try {
      const got = [mine, theirs, otherAgency, notif].map((s) => received(s, 'message'));
      const data = {
        agencyId: AGENCY,
        message: {
          id: NOTIFICATION,
          threadId: THREAD,
          sender: { agencyId: AGENCY, userId: OTHER_USER, name: 'Ana', ownAgency: true },
          body: 'Hola',
          createdAt: '2026-10-24T10:00:00.000Z',
        },
      };
      publish?.({ userId: USER, agencyId: AGENCY, namespace: '/chat', event: 'message', data });
      publish?.({ userId: USER, agencyId: AGENCY, namespace: '/chat', event: 'message', data: { ...data, extra: 1 } });
      publish?.({ userId: USER, agencyId: AGENCY, namespace: '/chat', event: 'typing', data });
      const [gotMine, gotTheirs, gotOther, gotNotif] = await Promise.all(got);
      expect(gotMine).toEqual([data]);
      expect(gotTheirs).toEqual([]);
      expect(gotOther).toEqual([]);
      expect(gotNotif).toEqual([]);
    } finally {
      for (const s of [mine, theirs, otherAgency, notif]) s.close();
    }
  });

  it('[S11-03] /chat counts each user across nodes: joins over the per-user limit and an 11th socket on a node are refused', async () => {
    const [over] = connected(await open('/chat', LIMITED));
    try {
      expect(await ask(over, 'join', { threadId: THREAD })).toEqual({ ok: false, error: 'RATE_LIMITED' });
      expect(limited).toContain(`realtime.chat.connect.user:${AGENCY}:${LIMITED}`);
      expect(limited).toContain(`realtime.chat.join.user:${AGENCY}:${LIMITED}`);
    } finally {
      over.close();
    }
    const tabs: Socket[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const [tab] = connected(await open('/chat', OTHER_USER));
        tabs.push(tab);
      }
      expect(await open('/chat', OTHER_USER)).toBe('RATE_LIMITED');
      // another user of the agency is not affected
      const [other] = connected(await open('/chat', USER));
      other.close();
    } finally {
      for (const t of tabs) t.close();
    }
  });

  it('[S12-F11] /notifications refuses an 11th socket of a user on a node; another user is not affected', async () => {
    const tabs: Socket[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const [tab] = connected(await open('/notifications', OTHER_USER));
        tabs.push(tab);
      }
      expect(await open('/notifications', OTHER_USER)).toBe('RATE_LIMITED');
      const [other] = connected(await open('/notifications', USER));
      other.close();
    } finally {
      for (const t of tabs) t.close();
    }
  });

  it('[S12-F11] /notifications counts connects per user across nodes: the 31st connect in a minute is refused', async () => {
    expect(NOTIFICATIONS_RATE_RULES.connect).toEqual({
      name: 'realtime.notifications.connect.user',
      scope: 'user',
      limit: 30,
      windowSeconds: 60,
    });
    connects = 0;
    for (let i = 0; i < 30; i++) {
      // one tab at a time: the per-node socket cap is not what refuses here
      const [tab] = connected(await open('/notifications', CONNECTOR));
      tab.close();
    }
    expect(await open('/notifications', CONNECTOR)).toBe('RATE_LIMITED');
    expect(connects).toBe(31);
    expect(limited).toContain(`realtime.notifications.connect.user:${AGENCY}:${CONNECTOR}`);
  });

  /** A socket on `namespace` with this exact token, or the connect_error message. */
  const openWith = (namespace: string, token: string) =>
    new Promise<Socket | string>((resolve) => {
      const socket = connect(`${url}${namespace}`, {
        transports: ['websocket'],
        reconnection: false,
        auth: { token },
        extraHeaders: { origin: ORIGIN },
      });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', (err) => {
        socket.close();
        resolve(err.message);
      });
    });
  /** Resolves with the ms until `socket` is disconnected by the server, or -1 after `ms`. */
  const closedWithin = (socket: Socket, ms: number) =>
    new Promise<number>((resolve) => {
      const start = Date.now();
      const timer = setTimeout(() => resolve(-1), ms);
      socket.once('disconnect', (reason) => {
        clearTimeout(timer);
        resolve(reason === 'io server disconnect' ? Date.now() - start : -2);
      });
    });
  const revoke = (
    userId: string,
    data: { sessionVersion: number | null; deactivatedAt: string | null },
    agencyId = AGENCY,
  ) => publish?.({ userId, agencyId, namespace: '/session', event: 'revoked', data });
  const deactivated = () => ({ sessionVersion: null, deactivatedAt: new Date().toISOString() });

  it('[S12-F10] a deactivated member’s open sockets close within 1 s on /chat and /notifications, they get no push, and their old token cannot reconnect', async () => {
    const { token } = await signer.sign({ sub: DEACTIVATED, aud: 'realtime', sv: 1, agency: AGENCY });
    const [chatTab, notifTab, colleague, sameUserOtherAgency] = connected(
      await openWith('/chat', token),
      await openWith('/notifications', token),
      await open('/notifications', USER),
      await open('/notifications', DEACTIVATED, { agency: OTHER_AGENCY }),
    );
    try {
      const got = received(notifTab, 'notification', 1_200);
      const closed = [closedWithin(chatTab, 1_000), closedWithin(notifTab, 1_000)];
      revoke(DEACTIVATED, deactivated());
      for (const ms of await Promise.all(closed)) {
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThan(1_000);
      }
      realtime.deliver({
        userId: DEACTIVATED,
        agencyId: AGENCY,
        namespace: '/notifications',
        event: 'notification',
        data: push(AGENCY),
      });
      expect(await got).toEqual([]);
      // a colleague, and the same user's socket in another agency, stay connected
      expect(colleague.connected).toBe(true);
      expect(sameUserOtherAgency.connected).toBe(true);
      expect(await openWith('/chat', token)).toBe('NOT_AUTHENTICATED');
      expect(await openWith('/notifications', token)).toBe('NOT_AUTHENTICATED');
    } finally {
      for (const s of [chatTab, notifTab, colleague, sameUserOtherAgency]) s.close();
    }
  });

  it('[S12-F10] revoked sessions (session version moved on) close; a socket on a newer session stays; malformed revocations are dropped', async () => {
    const old = (await signer.sign({ sub: RESET, aud: 'realtime', sv: 1, agency: AGENCY })).token;
    const fresh = (await signer.sign({ sub: RESET, aud: 'realtime', sv: 2, agency: AGENCY })).token;
    const [oldTab, freshTab] = connected(await openWith('/chat', old), await openWith('/notifications', fresh));
    try {
      // not a SessionRevokedPush, or another event name: nothing closes
      publish?.({ userId: RESET, agencyId: AGENCY, namespace: '/session', event: 'revoked', data: { x: 1 } });
      publish?.({
        userId: RESET,
        agencyId: AGENCY,
        namespace: '/session',
        event: 'other',
        data: { sessionVersion: 9 },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(oldTab.connected).toBe(true);

      const closed = closedWithin(oldTab, 1_000);
      revoke(RESET, { sessionVersion: 2, deactivatedAt: null });
      const ms = await closed;
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(1_000);
      expect(freshTab.connected).toBe(true);
      expect(await openWith('/notifications', old)).toBe('NOT_AUTHENTICATED');
      const [again] = connected(await openWith('/chat', fresh));
      again.close();
    } finally {
      for (const s of [oldTab, freshTab]) s.close();
    }
  });

  it('[S12-F10] a node that never heard of a revocation refuses the old token from the shared store; a store error lets the socket in', async () => {
    const old = (await signer.sign({ sub: SHARED, aud: 'realtime', sv: 1, agency: AGENCY })).token;
    sharedRevocations.set(`${AGENCY}:${SHARED}`, { deactivatedAt: null, sessionVersion: 2 });
    expect(await openWith('/chat', old)).toBe('NOT_AUTHENTICATED');
    expect(await openWith('/notifications', old)).toBe('NOT_AUTHENTICATED');
    const fresh = (await signer.sign({ sub: SHARED, aud: 'realtime', sv: 2, agency: AGENCY })).token;
    const [ok] = connected(await openWith('/notifications', fresh));
    ok.close();
    // deactivated (database time) a moment ago: a token issued before it, or within the 1 s slack after, is refused
    sharedRevocations.set(`${AGENCY}:${SHARED}`, { deactivatedAt: Date.now(), sessionVersion: null });
    expect(await openWith('/chat', fresh)).toBe('NOT_AUTHENTICATED');
    // fail open, like the limiter
    const [down] = connected(await open('/chat', SHARED_DOWN));
    down.close();
  });

  it('[S12-F10] [S12-F4] a revocation that arrives while the connect waits on Redis still closes the socket (not skipped as non-local)', async () => {
    const waiting = new Promise<void>((resolve) => {
      racerWaiting = resolve;
    });
    const opening = open('/notifications', RACER);
    await waiting; // admit is inside `deps.limit`; the socket is not in its room yet
    // S12-F4: a member waiting in admit counts as local, so the subscription does not skip the revocation
    expect(realtime.isLocal(AGENCY, RACER)).toBe(true);
    revoke(RACER, deactivated());
    releaseRacer?.();
    const socket = await opening;
    if (typeof socket === 'string') {
      expect(socket).toBe('NOT_AUTHENTICATED');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(socket.connected).toBe(false);
    socket.close();
  });

  it('[S12-F4] a member is local only while one of their sockets is on this node (/notifications or /chat)', async () => {
    expect(realtime.isLocal(AGENCY, STRANGER)).toBe(false);
    const [notif] = connected(await open('/notifications', STRANGER));
    expect(realtime.isLocal(AGENCY, STRANGER)).toBe(true);
    expect(realtime.isLocal(OTHER_AGENCY, STRANGER)).toBe(false);
    const [chatTab] = connected(await open('/chat', STRANGER));
    notif.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(realtime.isLocal(AGENCY, STRANGER)).toBe(true);
    chatTab.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(realtime.isLocal(AGENCY, STRANGER)).toBe(false);
  });
});
