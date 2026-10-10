import type { AddressInfo } from 'node:net';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type RealtimeApp } from './app';

const USER = '0192a0b4-0000-7000-8000-000000000001';
const ORIGIN = 'http://localhost:3100';
const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 'k1' });

let realtime: RealtimeApp;
let url = '';

beforeAll(async () => {
  realtime = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    checks: { redis: async () => {} },
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(`k1:${pair.publicKey}`) }),
    allowedOrigins: [ORIGIN],
  });
  await realtime.app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(realtime.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await realtime.drain();
  expect(realtime.app.server.listening).toBe(false);
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
});
