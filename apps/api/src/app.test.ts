import { createFakeClock } from '@inmolink/platform/clock';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const USER = '0192a0b4-0000-7000-8000-000000000001';
const pair = generateAccessKeyPair();
const clock = createFakeClock(Date.now());
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 'k1', clock });
const verifier = createAccessTokenVerifier({ publicKeys: parsePublicKeys(`k1:${pair.publicKey}`), clock });

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function app(docsUi = false, limiter: RateLimiter = allowAll) {
  const a = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi,
    limiter,
    checks: { db: async () => {} },
    verifier,
  });
  apps.push(a);
  return a;
}

const me = (a: Awaited<ReturnType<typeof app>>, token?: string) =>
  a.inject({ method: 'GET', url: '/v1/me', headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('api app', () => {
  it('[S0-08] api boots with health routes', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const ready = await a.inject({ method: 'GET', url: '/readyz' });
    expect(ready.json()).toEqual({ status: 'ok', checks: { db: 'ok' } });
  });

  it('[S0-08] serves /docs only when enabled (development)', async () => {
    expect((await (await app(true)).inject({ method: 'GET', url: '/docs' })).statusCode).not.toBe(404);
    expect((await (await app(false)).inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
  });

  it('[S0-08] withCtx refuses a request without a session (NOT_AUTHENTICATED)', async () => {
    const a = await app();
    a.get('/tenant-thing', (req) => a.withCtx(req, async (ctx) => ({ agencyId: ctx.tenant.agencyId })));
    const res = await a.inject({ method: 'GET', url: '/tenant-thing' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('NOT_AUTHENTICATED');
  });
});

describe('requireSession', () => {
  it('[S0-09] a valid api token reaches the authenticated route', async () => {
    const { token, expiresAt } = await signer.sign({ sub: USER, aud: 'api', sv: 2 });
    const res = await me(await app(), token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: USER,
      agencyId: null,
      sessionVersion: 2,
      tokenExpiresAt: expiresAt.toISOString(),
    });
  });

  it('[S0-09] an expired JWT is rejected with 401', async () => {
    const { token } = await signer.sign({ sub: USER, aud: 'api', sv: 1 });
    clock.advance((ACCESS_TOKEN_TTL_SECONDS + 10) * 1_000);
    try {
      const res = await me(await app(), token);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('NOT_AUTHENTICATED');
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    } finally {
      clock.set(Date.now());
    }
  });

  it('[S0-09] a wrong-audience JWT (realtime) is rejected with 401', async () => {
    const { token } = await signer.sign({ sub: USER, aud: 'realtime', sv: 1 });
    const res = await me(await app(), token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('NOT_AUTHENTICATED');
  });

  it('[S0-09] missing, malformed or foreign-key tokens are rejected with 401; cookies are ignored', async () => {
    const a = await app();
    expect((await me(a)).statusCode).toBe(401);
    expect((await me(a, 'garbage')).statusCode).toBe(401);
    const foreign = generateAccessKeyPair();
    const forged = await createAccessTokenSigner({
      privateKey: privateKeyFromBase64(foreign.privateKey),
      keyId: 'k1',
    }).sign({ sub: USER, aud: 'api', sv: 1 });
    expect((await me(a, forged.token)).statusCode).toBe(401);
    const cookie = await a.inject({ method: 'GET', url: '/v1/me', headers: { cookie: 'authjs.session-token=x' } });
    expect(cookie.statusCode).toBe(401);
  });

  it('[S1-F5] a 401 body is identical for expired, unknown-key and wrong-audience tokens', async () => {
    const a = await app();
    const expiring = (await signer.sign({ sub: USER, aud: 'api', sv: 1 })).token;
    clock.advance((ACCESS_TOKEN_TTL_SECONDS + 10) * 1_000);
    try {
      // Signed after the clock moved: each fails for its own reason only.
      const wrongAudience = (await signer.sign({ sub: USER, aud: 'realtime', sv: 1 })).token;
      const unknownKey = (
        await createAccessTokenSigner({
          privateKey: privateKeyFromBase64(pair.privateKey),
          keyId: 'k9',
          clock,
        }).sign({ sub: USER, aud: 'api', sv: 1 })
      ).token;
      const bodies = await Promise.all(
        [expiring, unknownKey, wrongAudience, undefined].map(async (t) => {
          const res = await me(a, t);
          expect(res.statusCode).toBe(401);
          return res.body;
        }),
      );
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0] as string)).toEqual({
        error: { code: 'NOT_AUTHENTICATED', message: 'Unauthorized' },
      });
    } finally {
      clock.set(Date.now());
    }
  });

  it('[S0-09] the per-user rate limit sees the authenticated user', async () => {
    const seen: string[] = [];
    const recording = {
      consume: async (rule: { name: string }, identity: string) => {
        seen.push(`${rule.name}=${identity}`);
        return { allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 };
      },
    } as unknown as RateLimiter;
    const { token } = await signer.sign({ sub: USER, aud: 'api', sv: 1 });
    expect((await me(await app(false, recording), token)).statusCode).toBe(200);
    expect(seen).toContain(`identity.me.user=${USER}`);
  });

  it('[S2-F2] staff impersonating a member use their own rate-limit bucket', async () => {
    const seen: string[] = [];
    const recording = {
      consume: async (rule: { name: string }, identity: string) => {
        seen.push(`${rule.name}=${identity}`);
        return { allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 };
      },
    } as unknown as RateLimiter;
    const STAFF = '0192a0b4-0000-7000-8000-0000000000f5';
    const { token } = await signer.sign({
      sub: USER,
      aud: 'api',
      sv: 1,
      agency: '0192a0b4-0000-7000-8000-00000000a9e1',
      act: STAFF,
      imp: '0192a0b4-0000-7000-8000-0000000001a1',
    });
    await me(await app(false, recording), token);
    const userRules = seen.filter((s) => s.startsWith('identity.me.user='));
    expect(userRules).toEqual([`identity.me.user=${STAFF}`]);
  });
});
