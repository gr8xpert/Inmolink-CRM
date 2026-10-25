import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import {
  cacheConnection,
  closeCache,
  configureCache,
  sessionRevocation,
  type UserEvent,
  whenReady,
} from '@inmolink/platform/cache';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { newToken } from '@inmolink/platform/crypto';
import { closeEmail, configureEmail, createMemoryMailer, type MemoryMailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authCtx } from '../../../context';
import * as identity from '../index';

/** Identity flows on the real test database: `app_auth` for requests, `app_system` for the email job. */

const pair = generateAccessKeyPair();
const verifier = createAccessTokenVerifier({ publicKeys: parsePublicKeys(`t1:${pair.publicKey}`) });
const log = createLogger({ service: 'identity-test', level: 'silent' });
const ctx = () => authCtx(newId());
let mail: MemoryMailer;

beforeAll(async () => {
  await setupTestDb('worker');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    webUrl: 'http://web.test',
    signer: createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' }),
  });
  // Re-sent confirmation links are throttled per user in redis-cache (S1-F4).
  await configureCache({ url: process.env.REDIS_CACHE_URL, commandTimeoutMs: 2_000 });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

beforeEach(async () => {
  mail = createMemoryMailer();
  await configureEmail(mail);
});

afterEach(() => restoreClock());

afterAll(async () => {
  await closeCache();
  await closeRateLimit();
  await closeEmail();
  await closeDb();
});

const AGENCY = { accountKind: 'AGENCY', companyName: 'Costa Homes S.L.' } as const;
const uniqueEmail = () => `user-${newToken(6).toLowerCase()}@example.com`;

interface OutboxRow {
  id: string;
  type: string;
  agency_id: string;
  payload: { userId: string };
}

/** Outbox events for one user, oldest first. */
async function eventsFor(userIdOrEmail: string): Promise<OutboxRow[]> {
  return withSystem('identity test: read outbox', async (tx) => {
    const r = await tx.execute(sql`
      select o.id, o.type, o.agency_id, o.payload from outbox_events o
       where o.payload->>'userId' = ${userIdOrEmail}
          or o.payload->>'userId' = (select id::text from users where email = ${userIdOrEmail})
       order by o.created_at, o.id`);
    return r.rows as unknown as OutboxRow[];
  });
}

/** Delivers the latest auth event for the user the way the worker would, and returns the emailed link. */
async function deliverLatest(email: string): Promise<URL> {
  const events = await eventsFor(email);
  const e = events.at(-1);
  if (!e) throw new Error('no event');
  const kind =
    e.type === 'identity.passwordReset.requested'
      ? 'PASSWORD_RESET'
      : e.type === 'identity.signup.duplicated'
        ? 'ACCOUNT_EXISTS'
        : 'VERIFY_EMAIL';
  await identity.identityJobs.sendAuthEmail.spec.run(
    { eventId: e.id, userId: e.payload.userId, kind },
    { log, jobId: e.id, attempt: 1, progress: async () => {}, signal: new AbortController().signal },
  );
  const sent = mail.sent.at(-1);
  if (!sent) throw new Error('no email sent');
  const href = /https?:\/\/\S+/.exec(sent.text)?.[0];
  if (!href) throw new Error('no link in email');
  return new URL(href);
}

async function signUpAndVerify(email = uniqueEmail(), password = 'correct horse battery') {
  await identity.register(ctx(), { email, password, name: 'Ana', locale: 'es', ...AGENCY });
  const link = await deliverLatest(email);
  await identity.verifyEmail(ctx(), { token: link.searchParams.get('token') ?? '', password });
  return { email, password };
}

describe('identity sign-up and verification', () => {
  it('[S0-09] sign-up stores an unverified user and queues the confirmation email in the same transaction', async () => {
    const email = uniqueEmail();
    await identity.register(ctx(), { email, password: 'correct horse battery', name: 'Ana', locale: 'es', ...AGENCY });
    const events = await eventsFor(email);
    expect(events.map((e) => e.type)).toEqual(['identity.user.registered']);
    expect(events[0]?.agency_id).toBe('00000000-0000-0000-0000-000000000000');
    await expect(identity.verifyCredentials(ctx(), { email, password: 'correct horse battery' })).rejects.toMatchObject(
      {
        code: 'EMAIL_NOT_VERIFIED',
      },
    );
  });

  it('[S1-F4] ten logins to an unverified account within 10 minutes send one email', async () => {
    const email = uniqueEmail();
    await identity.register(ctx(), { email, password: 'correct horse battery', name: 'Ana', locale: 'en', ...AGENCY });
    for (let i = 0; i < 10; i++) {
      await expect(
        identity.verifyCredentials(ctx(), { email, password: 'correct horse battery' }),
      ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    }
    const resent = (await eventsFor(email)).filter((e) => e.type === 'identity.verification.requested');
    expect(resent).toHaveLength(1);
    // A wrong password never triggers an email at all.
    await expect(identity.verifyCredentials(ctx(), { email, password: 'wrong password!' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect((await eventsFor(email)).filter((e) => e.type === 'identity.verification.requested')).toHaveLength(1);
  });

  it('[S0-09] the confirmation email (in the user locale) verifies the address once; then login works', async () => {
    const email = uniqueEmail();
    await identity.register(ctx(), { email, password: 'correct horse battery', name: 'Ana', locale: 'es', ...AGENCY });
    const link = await deliverLatest(email);
    expect(link.origin + link.pathname).toBe('http://web.test/es/verify-email');
    expect(mail.sent.at(-1)?.subject).toBe('Confirma tu correo en Inmolink');
    const token = link.searchParams.get('token') ?? '';
    await identity.verifyEmail(ctx(), { token, password: 'correct horse battery' });
    await expect(identity.verifyEmail(ctx(), { token, password: 'correct horse battery' })).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    const user = await identity.verifyCredentials(ctx(), { email, password: 'correct horse battery' });
    expect(user).toMatchObject({ email, name: 'Ana', locale: 'es', sessionVersion: 1 });
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('[S0-09] signing up with a taken email changes nothing and emails the owner instead', async () => {
    const { email } = await signUpAndVerify();
    await identity.register(ctx(), { email, password: 'another password!', name: 'Mallory', locale: 'en', ...AGENCY });
    const events = await eventsFor(email);
    expect(events.at(-1)?.type).toBe('identity.signup.duplicated');
    await deliverLatest(email);
    expect(mail.sent.at(-1)?.subject).toBe('Ya tienes una cuenta de Inmolink');
    await expect(identity.verifyCredentials(ctx(), { email, password: 'another password!' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('[S0-09] wrong password and unknown email are the same error', async () => {
    const { email } = await signUpAndVerify();
    await expect(identity.verifyCredentials(ctx(), { email, password: 'wrong password' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(
      identity.verifyCredentials(ctx(), { email: uniqueEmail(), password: 'wrong password' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('[S0-09] login with an unconfirmed email queues a fresh link; only the newest link works', async () => {
    const email = uniqueEmail();
    await identity.register(ctx(), { email, password: 'correct horse battery', name: 'Ana', locale: 'en', ...AGENCY });
    const first = await deliverLatest(email);
    await expect(identity.verifyCredentials(ctx(), { email, password: 'correct horse battery' })).rejects.toMatchObject(
      {
        code: 'EMAIL_NOT_VERIFIED',
      },
    );
    expect((await eventsFor(email)).at(-1)?.type).toBe('identity.verification.requested');
    const second = await deliverLatest(email);
    await expect(
      identity.verifyEmail(ctx(), { token: first.searchParams.get('token') ?? '', password: 'correct horse battery' }),
    ).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    await identity.verifyEmail(ctx(), {
      token: second.searchParams.get('token') ?? '',
      password: 'correct horse battery',
    });
  });

  it('[S0-09] someone who signs up with another person’s email cannot get it confirmed by them (pre-account hijack)', async () => {
    const email = uniqueEmail();
    await identity.register(ctx(), {
      email,
      password: 'attacker password',
      name: 'Mallory',
      locale: 'en',
      accountKind: 'DEVELOPER',
      companyName: 'Mallory Homes',
    });
    const attackerLink = await deliverLatest(email);
    const attackerToken = attackerLink.searchParams.get('token') ?? '';
    // The owner clicks the link but does not know the attacker's password.
    await expect(
      identity.verifyEmail(ctx(), { token: attackerToken, password: 'owner password!' }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    // The owner signs up themselves: the pending account is replaced and only the new link works.
    await identity.register(ctx(), { email, password: 'owner password!', name: 'Ana', locale: 'es', ...AGENCY });
    const ownerLink = await deliverLatest(email);
    await expect(
      identity.verifyEmail(ctx(), { token: attackerToken, password: 'attacker password' }),
    ).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    await identity.verifyEmail(ctx(), {
      token: ownerLink.searchParams.get('token') ?? '',
      password: 'owner password!',
    });
    await expect(identity.verifyCredentials(ctx(), { email, password: 'attacker password' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(identity.verifyCredentials(ctx(), { email, password: 'owner password!' })).resolves.toMatchObject({
      name: 'Ana',
    });
  });
});

describe('identity password reset', () => {
  async function requestReset(email: string): Promise<string> {
    await identity.requestPasswordReset(ctx(), { email });
    const link = await deliverLatest(email);
    expect(link.pathname).toBe('/es/reset-password');
    return link.searchParams.get('token') ?? '';
  }

  it('[S0-09] reset tokens are single-use', async () => {
    const { email } = await signUpAndVerify();
    const token = await requestReset(email);
    await identity.resetPassword(ctx(), { token, password: 'brand new password' });
    await expect(identity.resetPassword(ctx(), { token, password: 'second new password' })).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    await expect(identity.verifyCredentials(ctx(), { email, password: 'brand new password' })).resolves.toMatchObject({
      email,
    });
  });

  it('[S0-09] reset tokens expire in 60 minutes', async () => {
    const { email } = await signUpAndVerify();
    const clock = useFakeClock(Date.now());
    const expired = await requestReset(email);
    clock.advance(60 * 60_000 + 1_000);
    await expect(
      identity.resetPassword(ctx(), { token: expired, password: 'brand new password' }),
    ).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });

    const fresh = await requestReset(email);
    clock.advance(59 * 60_000);
    await expect(
      identity.resetPassword(ctx(), { token: fresh, password: 'brand new password' }),
    ).resolves.toMatchObject({});
  });

  it('[S0-09] a newer reset link retires the older one; unknown emails send nothing', async () => {
    const { email } = await signUpAndVerify();
    const older = await requestReset(email);
    const newer = await requestReset(email);
    await expect(identity.resetPassword(ctx(), { token: older, password: 'brand new password' })).rejects.toMatchObject(
      {
        code: 'TOKEN_INVALID',
      },
    );
    await identity.resetPassword(ctx(), { token: newer, password: 'brand new password' });

    const unknown = uniqueEmail();
    await identity.requestPasswordReset(ctx(), { email: unknown });
    expect(await eventsFor(unknown)).toEqual([]);
  });

  it('[S12-F10] a password reset emits identity.sessions.revoked; its subscriber tells realtime the new session version for the user’s agency', async () => {
    const { email, password } = await signUpAndVerify();
    const user = await identity.verifyCredentials(ctx(), { email, password });
    const token = await requestReset(email);
    await identity.resetPassword(ctx(), { token, password: 'brand new password' });
    const revoked = (await eventsFor(user.id)).filter((e) => e.type === 'identity.sessions.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.payload).toEqual({ userId: user.id });

    await whenReady(cacheConnection(), 10_000); // redis-cache commands fail fast until connected
    const published: UserEvent[] = [];
    const res = await identity.disconnectRevokedSessions({ userId: user.id }, async (e) => void published.push(...e));
    const agencyId = await withSystem('identity test: membership', async (tx) => {
      const r = await tx.execute(sql`select agency_id from agency_members where user_id = ${user.id}`);
      return (r.rows[0] as { agency_id: string }).agency_id;
    });
    expect(res).toEqual({ agencies: 1 });
    expect(published).toEqual([
      {
        userId: user.id,
        agencyId,
        namespace: '/session',
        event: 'revoked',
        data: { sessionVersion: 2, deactivatedAt: null },
      },
    ]);
    // stored for every realtime node first (a restarted node still refuses the old token)
    expect(await sessionRevocation(agencyId, user.id)).toEqual({ deactivatedAt: null, sessionVersion: 2 });

    // a deactivation closes every socket of the member in that agency issued before it (database time); an active
    // member publishes nothing
    published.length = 0;
    const record = async (e: readonly UserEvent[]) => void published.push(...e);
    expect(await identity.disconnectDeactivatedMember({ agencyId, userId: user.id }, record)).toEqual({
      revoked: false,
    });
    const at = await withSystem('identity test: deactivate', async (tx) => {
      const r = await tx.execute(sql`update agency_members set deactivated_at = now() where user_id = ${user.id}
        returning deactivated_at`);
      return new Date((r.rows[0] as { deactivated_at: string | Date }).deactivated_at);
    });
    expect(await identity.disconnectDeactivatedMember({ agencyId, userId: user.id }, record)).toEqual({
      revoked: true,
    });
    expect(published).toEqual([
      {
        userId: user.id,
        agencyId,
        namespace: '/session',
        event: 'revoked',
        data: { sessionVersion: null, deactivatedAt: at.toISOString() },
      },
    ]);
    expect(await sessionRevocation(agencyId, user.id)).toEqual({ deactivatedAt: at.getTime(), sessionVersion: 2 });
    // an unknown user publishes nothing
    expect(await identity.disconnectRevokedSessions({ userId: newId() }, async () => {})).toEqual({ agencies: 0 });
  });

  it('[S0-09] a password reset revokes existing sessions (no new access tokens for the old session)', async () => {
    const { email, password } = await signUpAndVerify();
    const user = await identity.verifyCredentials(ctx(), { email, password });
    const before = await identity.issueAccessToken(ctx(), {
      userId: user.id,
      sessionVersion: 1,
      audience: 'api',
      mfaVerified: true,
    });
    await expect(verifier.verify(before.token, 'api')).resolves.toMatchObject({ sub: user.id, sv: 1 });

    const token = await requestReset(email);
    await identity.resetPassword(ctx(), { token, password: 'brand new password' });
    await expect(
      identity.issueAccessToken(ctx(), { userId: user.id, sessionVersion: 1, audience: 'api', mfaVerified: true }),
    ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    const again = await identity.verifyCredentials(ctx(), { email, password: 'brand new password' });
    expect(again.sessionVersion).toBe(2);
    expect(await identity.isSessionValid(ctx(), { userId: user.id, sessionVersion: 1 })).toBe(false);
    expect(await identity.isSessionValid(ctx(), { userId: user.id, sessionVersion: 2 })).toBe(true);
  });
});
