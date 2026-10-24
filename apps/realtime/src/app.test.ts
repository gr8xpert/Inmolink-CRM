import type { AddressInfo } from 'node:net';
import type { UserEvent } from '@inmolink/platform/cache';
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
import { buildApp, type RealtimeApp } from './app';

const USER = '0192a0b4-0000-7000-8000-000000000001';
const OTHER_USER = '0192a0b4-0000-7000-8000-000000000002';
const AGENCY = '0192a0b4-0000-7000-8000-0000000000a1';
const OTHER_AGENCY = '0192a0b4-0000-7000-8000-0000000000a2';
const NOTIFICATION = '0192a0b4-0000-7000-8000-0000000000f1';
const STAFF = '0192a0b4-0000-7000-8000-0000000000b1';
const SESSION = '0192a0b4-0000-7000-8000-0000000000c1';
const ORIGIN = 'http://localhost:3100';
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
    userEvents: async (handler) => {
      publish = handler;
      return async () => {
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
});
