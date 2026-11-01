import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { whenReady } from '@inmolink/platform/cache';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { hmacSha256 } from '@inmolink/platform/crypto';
import { hashPassword } from '@inmolink/platform/crypto/password';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createAccessTokenSigner, generateAccessKeyPair, privateKeyFromBase64 } from '@inmolink/platform/jwt';
import { closeRateLimit, configureRateLimit, rateLimitConnection } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authCtx, type Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as identity from '../index';

/**
 * Client Mode (S12-06 + security review): entering hands a signed PIN hash to the web session, which activates it
 * server-side (per session and per member); leaving checks the PIN — the attempt budget first, rate-limited per user,
 * audited when wrong, and the session ends when the budget is used up. Mints follow the server-side state.
 */

const pair = generateAccessKeyPair();
const HMAC_KEY = 'test-hmac-key-0123456789abcdef0123456789';
const auth = () => authCtx(newId());
const sid = () => randomBytes(18).toString('base64url');

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>, clientMode = false) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en', clientMode }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function auditRows(userId: string) {
  return withSystem('identity.client-mode.test', async (tx) => {
    const r = await tx.execute<{
      type: string;
      actor_kind: string;
      agency_id: string;
      metadata: Record<string, unknown>;
    }>(
      sql`select type, actor_kind, agency_id, metadata from audit_logs
           where (type like 'identity.clientMode.%' or type = 'identity.twoFactor.devicesForgotten')
             and target_id = ${userId}::uuid order by occurred_at, id`,
    );
    return r.rows;
  });
}

/** Enters Client Mode for a new web session of `m` with `pin`. */
async function enter(m: Founder, pin: string, sessionId = sid()) {
  const { proof } = await as(m, (ctx) => identity.startClientMode(ctx, { pin }));
  const state = await identity.activateClientMode({ userId: m.userId, sessionId, proof });
  if (!state) throw new Error('not activated');
  return { state, sessionId, proof };
}

/** A start proof signed like `startClientMode`'s, with an attempt limit of our choosing. */
async function craftedProof(userId: string, pin: string, m: number): Promise<string> {
  const payload = Buffer.from(
    JSON.stringify({
      u: userId,
      h: await hashPassword(pin),
      n: randomBytes(18).toString('base64url'),
      m,
      e: Date.now() + 60_000,
    }),
  ).toString('base64url');
  return `${payload}.${hmacSha256(HMAC_KEY, 'client-mode-start', payload)}`;
}

const mint = (m: Founder, sessionId: string, audience: 'api' | 'realtime' = 'api', clientMode = false) =>
  identity.issueAccessToken(auth(), {
    userId: m.userId,
    sessionVersion: 1,
    mfaVerified: true,
    audience,
    clientMode,
    sessionId,
  });
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString());

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  identity.configureIdentity({
    hmacKey: HMAC_KEY,
    webUrl: 'http://web.test',
    signer: createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' }),
  });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
}, 120_000);

afterEach(() => restoreClock());

afterAll(async () => {
  await closeRateLimit();
  await closeDb();
});

describe('Client Mode (S12-06)', () => {
  it('[S12-06] entering returns a signed proof that activates once, for that member, before it expires', async () => {
    const m = await createFounder();
    const { proof } = await as(m, (ctx) => identity.startClientMode(ctx, { pin: '4821' }));
    expect(identity.openClientModeProof({ userId: m.userId, proof })?.m).toBe(5); // the agency's default policy
    expect(proof).not.toContain('4821');
    // Someone else's session, a tampered or a foreign proof: nothing.
    expect(await identity.activateClientMode({ userId: newId(), sessionId: sid(), proof })).toBeNull();
    const [payload, mac] = proof.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload as string, 'base64url').toString()), m: 1_000 }),
    ).toString('base64url');
    expect(identity.openClientModeProof({ userId: m.userId, proof: `${forged}.${mac}` })).toBeNull();
    expect(identity.openClientModeProof({ userId: m.userId, proof: 'x.y' })).toBeNull();
    expect(identity.openClientModeProof({ userId: m.userId, proof: 42 })).toBeNull();
    useFakeClock(Date.now() + identity.CLIENT_MODE_PROOF_TTL_MS + 1_000);
    expect(identity.openClientModeProof({ userId: m.userId, proof })).toBeNull();
    restoreClock();
    // Activated once: a replayed proof is refused.
    expect(await identity.activateClientMode({ userId: m.userId, sessionId: sid(), proof })).not.toBeNull();
    expect(await identity.activateClientMode({ userId: m.userId, sessionId: sid(), proof })).toBeNull();

    expect(await refusal(as(m, (ctx) => identity.startClientMode(ctx, { pin: '123' })))).toBe('VALIDATION_FAILED');
    expect(await refusal(as(m, (ctx) => identity.startClientMode(ctx, { pin: '9999' }), true))).toBe('FORBIDDEN');
    expect((await auditRows(m.userId)).map((r) => r.type)).toEqual(['identity.clientMode.started']);
  });

  it('[S12-06] mints follow the server-side state: an older cookie of the session and a new login get cm', async () => {
    const m = await createFounder();
    const { state, sessionId } = await enter(m, '4821');
    // The cookie says nothing (a copy from before Client Mode): the session's server-side state decides.
    expect(claimsOf((await mint(m, sessionId)).token).cm).toBe(true);
    expect(await refusal(mint(m, sessionId, 'realtime'))).toBe('FORBIDDEN');
    // Any other session of the member mints with cm too — one without an id (a cookie from before S12-06) included.
    expect(claimsOf((await mint(m, sid())).token).cm).toBe(true);
    expect(
      claimsOf(
        (
          await identity.issueAccessToken(auth(), {
            userId: m.userId,
            sessionVersion: 1,
            mfaVerified: true,
            audience: 'api',
          })
        ).token,
      ).cm,
    ).toBe(true);
    // A new login resumes the member's Client Mode.
    const login = sid();
    expect(await identity.clientModeAtLogin({ userId: m.userId, sessionId: login })).toEqual(state);
    expect(claimsOf((await mint(m, login)).token).cm).toBe(true);
    // The PIN ends it everywhere: this session, the new login and the member's marker.
    expect(await identity.checkClientModePin(auth(), { userId: m.userId, sessionId, state, pin: '4821' })).toBe('ok');
    expect(claimsOf((await mint(m, sessionId)).token).cm).toBeUndefined();
    expect(await identity.clientModeAtLogin({ userId: m.userId, sessionId: sid() })).toBeNull();
    // The other tab still holding the state: out too.
    expect(await identity.checkClientModePin(auth(), { userId: m.userId, sessionId: login, state, pin: '0000' })).toBe(
      'ok',
    );
    // A staff impersonation never mints from a Client Mode session.
    expect(
      await refusal(
        identity.issueAccessToken(auth(), {
          userId: m.userId,
          sessionVersion: 1,
          mfaVerified: true,
          audience: 'api',
          clientMode: true,
          impersonationId: newId(),
        }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('[S12-06] wrong PINs are audited; the budget is taken before the PIN and its last wrong PIN ends the session', async () => {
    const m = await createFounder();
    const { state, sessionId } = await enter(m, '4821');
    const check = (pin: unknown) => identity.checkClientModePin(auth(), { userId: m.userId, sessionId, state, pin });
    expect(await check('0000')).toBe('wrong');
    expect(await check('not a pin')).toBe('wrong');
    let rows = await auditRows(m.userId);
    expect(rows[2]).toMatchObject({
      type: 'identity.clientMode.pinFailed',
      actor_kind: 'anonymous',
      agency_id: m.agencyId,
      metadata: { reason: 'wrong', attemptsLeft: 3, locked: false },
    });
    expect(JSON.stringify(rows)).not.toContain('0000');
    // Parallel submits cannot outnumber the budget (5): of 6 at once, at most the 3 left are checked.
    const results = await Promise.all(Array.from({ length: 6 }, () => check('1111')));
    expect(results.filter((r) => r === 'wrong' || r === 'locked')).toHaveLength(3);
    expect(results.filter((r) => r === 'locked')).toHaveLength(1);
    expect(results.filter((r) => r === 'rate_limited')).toHaveLength(3);
    // Used up: even the right PIN waits; the lock forgot the member's remembered browsers.
    expect(await check('4821')).toBe('rate_limited');
    rows = await auditRows(m.userId);
    expect(rows.some((r) => r.type === 'identity.twoFactor.devicesForgotten')).toBe(true);
    expect(rows.filter((r) => r.metadata.reason === 'attempts_used_up').length).toBeGreaterThanOrEqual(3);
    // A new login is still in Client Mode (the PIN is the only way out).
    expect(await identity.clientModeAtLogin({ userId: m.userId, sessionId: sid() })).toEqual(state);
    // A Client Mode the server does not know (expired, forged cookie) ends the session.
    expect(
      await identity.checkClientModePin(auth(), {
        userId: m.userId,
        sessionId,
        state: { n: randomBytes(18).toString('base64url') },
        pin: '4821',
      }),
    ).toBe('locked');
  });

  it('[S12-06] PIN checks are rate-limited per user (fail closed) and a throttled attempt is audited', async () => {
    const m = await createFounder();
    const sessionId = sid();
    const state = await identity.activateClientMode({
      userId: m.userId,
      sessionId,
      proof: await craftedProof(m.userId, '4821', 10),
    });
    if (!state) throw new Error('not activated');
    const results: string[] = [];
    for (let i = 0; i < identity.CLIENT_MODE_PIN_LIMITS.user.limit + 1; i += 1) {
      results.push(await identity.checkClientModePin(auth(), { userId: m.userId, sessionId, state, pin: '1234' }));
    }
    expect(results.at(-1)).toBe('rate_limited');
    expect(results.slice(0, -1).every((r) => r === 'wrong')).toBe(true);
    expect(await identity.checkClientModePin(auth(), { userId: m.userId, sessionId, state, pin: '4821' })).toBe(
      'rate_limited',
    );
    const rows = await auditRows(m.userId);
    expect(rows.filter((r) => r.metadata.reason === 'rate_limited')).toHaveLength(2);
    expect(rows.filter((r) => r.metadata.reason === 'wrong')).toHaveLength(identity.CLIENT_MODE_PIN_LIMITS.user.limit);
  });
});

/** The ACL that production gives redis-queue's `limits` user (Ansible group_vars). */
function limitsAcl(): string {
  const vars = readFileSync(join(import.meta.dirname, '../../../../../../infra/ansible/group_vars/all.yml'), 'utf8');
  const acl = vars.match(/^redis_limits_acl: "([^"]+)"$/m)?.[1];
  if (!acl) throw new Error('redis_limits_acl missing from infra/ansible/group_vars/all.yml');
  return acl;
}

describe('Client Mode under the production limits ACL (S16-F11)', () => {
  /** Runs `fn` with the limits connection logged in as a fresh user with `acl`; the user is removed after. */
  async function asLimitsUser(acl: string, fn: () => Promise<void>): Promise<void> {
    const adminUrl = process.env.REDIS_LIMITS_URL as string;
    const admin = async () => {
      const redis = rateLimitConnection(); // the test stack's default user (configured in beforeAll)
      await whenReady(redis);
      return redis;
    };
    const user = `cm-acl-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const password = randomBytes(16).toString('hex');
    await (await admin()).call('ACL', 'SETUSER', user, 'on', `>${password}`, ...acl.split(' '));
    try {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      await configureRateLimit({ url: url.toString(), commandTimeoutMs: 2_000 });
      await fn();
    } finally {
      await configureRateLimit({ url: adminUrl, commandTimeoutMs: 2_000 });
      await (await admin()).call('ACL', 'DELUSER', user);
    }
  }

  it('[S16-F11] enter, login, mint, wrong and right PIN and exit work as the production limits user', async () => {
    const m = await createFounder();
    await asLimitsUser(limitsAcl(), async () => {
      const { state, sessionId } = await enter(m, '4821');
      expect(await identity.activeClientModeOf({ userId: m.userId, sessionId })).toEqual(state);
      expect(claimsOf((await mint(m, sessionId)).token).cm).toBe(true);
      const login = sid();
      expect(await identity.clientModeAtLogin({ userId: m.userId, sessionId: login })).toEqual(state);
      // The PIN check (attempt budget + per-user limits on `inl:rl:*`), wrong then right: exit ends it everywhere.
      const check = (pin: string) => identity.checkClientModePin(auth(), { userId: m.userId, sessionId, state, pin });
      expect(await check('0000')).toBe('wrong');
      expect(await check('4821')).toBe('ok');
      expect(await identity.activeClientModeOf({ userId: m.userId, sessionId })).toBeNull();
      expect(await identity.clientModeAtLogin({ userId: m.userId, sessionId: sid() })).toBeNull();
      expect(claimsOf((await mint(m, login)).token).cm).toBeUndefined();
    });
  });

  it('[S16-F11] the ACL before S16-F11 (counters only) refuses Client Mode with NOPERM', async () => {
    const old = limitsAcl().replace(/ \+multi \+exec \(.*\)$/, '');
    expect(old).not.toContain('inl:cm');
    const m = await createFounder();
    await asLimitsUser(old, async () => {
      const { proof } = await as(m, (ctx) => identity.startClientMode(ctx, { pin: '4821' }));
      await expect(identity.activateClientMode({ userId: m.userId, sessionId: sid(), proof })).rejects.toThrow(
        /NOPERM/,
      );
    });
  });
});
