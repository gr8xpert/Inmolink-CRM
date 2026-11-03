import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newToken } from '@inmolink/platform/crypto';
import { verifyPassword } from '@inmolink/platform/crypto/password';
import { newId } from '@inmolink/platform/ids';
import { createAccessTokenSigner, generateAccessKeyPair, privateKeyFromBase64 } from '@inmolink/platform/jwt';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authCtx } from '../../../context';
import { createFounder } from '../../../testing/factories';
import * as identity from '../index';
import { hashLinkToken } from '../service';

/** `pnpm staff:bootstrap` (S17-F14): the first staff login of a fresh server. */

beforeAll(async () => {
  await setupTestDb('worker');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    webUrl: 'http://web.test',
    apiKeyEnv: 'test',
    signer: createAccessTokenSigner({
      privateKey: privateKeyFromBase64(generateAccessKeyPair().privateKey),
      keyId: 't1',
    }),
  });
  await configureCache({ url: process.env.REDIS_CACHE_URL, commandTimeoutMs: 2_000 });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
}, 120_000);

afterAll(async () => {
  await closeCache();
  await closeRateLimit();
  await closeDb();
});

const address = () => `boot-${newToken(6).toLowerCase()}@staff.inmolink.test`;

const bootstrap = (email: string, role: identity.StaffRole = 'SUPER_ADMIN') =>
  withSystem('ops.staff.bootstrap: test', (tx) => identity.bootstrapStaff(tx, { email, role }));

/** The rows the command may touch, for one address. */
async function stateOf(email: string) {
  return withSystem('staff bootstrap test: read', async (tx) => {
    const one = async <T>(q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as unknown as T[];
    const [user] = await one<{
      id: string;
      password_hash: string;
      status: string;
      email_verified_at: unknown;
      updated_at: unknown;
    }>(sql`select id, password_hash, status, email_verified_at, updated_at from users where email = ${email}`);
    if (!user) return { user: null, staff: [], members: 0, tokens: 0, audit: [], events: [] };
    const staff = await one<{ role: string; deactivated_at: unknown }>(
      sql`select role, deactivated_at from staff_users where user_id = ${user.id}`,
    );
    const [members] = await one<{ n: number }>(
      sql`select count(*)::int as n from agency_members where user_id = ${user.id}`,
    );
    const [tokens] = await one<{ n: number }>(
      sql`select count(*)::int as n from auth_tokens where user_id = ${user.id}`,
    );
    const audit = await one<{
      type: string;
      agency_id: string;
      actor_kind: string;
      actor_user_id: string | null;
      metadata: unknown;
    }>(
      sql`select type, agency_id, actor_kind, actor_user_id, metadata from audit_logs
            where target_id = ${user.id} order by occurred_at, id`,
    );
    const events = await one<{ type: string }>(
      sql`select type from outbox_events where payload->>'userId' = ${user.id}`,
    );
    return { user, staff, members: members?.n ?? 0, tokens: tokens?.n ?? 0, audit, events };
  });
}

describe('staff bootstrap', () => {
  it('[S17-F14] creates and grants on an empty address', async () => {
    const email = address();
    const { userId, outcome } = await bootstrap(` ${email.toUpperCase()} `, 'STAFF_DATA_OPS');
    expect(outcome).toBe('created');
    const state = await stateOf(email);
    expect(state.user?.id).toBe(userId);
    expect(state.user?.status).toBe('ACTIVE');
    expect(state.user?.email_verified_at).toBeTruthy();
    expect(state.staff).toEqual([{ role: 'STAFF_DATA_OPS', deactivated_at: null }]);
    expect(state.members).toBe(0);
    // No confirmation email, no reset link: nothing was sent or issued.
    expect(state.tokens).toBe(0);
    expect(state.events).toEqual([]);
  });

  it('[S17-F14] running twice changes nothing and does not fail', async () => {
    const email = address();
    const first = await bootstrap(email);
    const before = await stateOf(email);
    const second = await bootstrap(email);
    expect(second).toEqual({ userId: first.userId, outcome: 'unchanged' });
    expect(await stateOf(email)).toEqual(before);
  });

  it('[S17-F14] refuses an agency member, and leaves them as they were', async () => {
    const founder = await createFounder();
    const email = founder.email.toLowerCase();
    await expect(bootstrap(email)).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'agency_member' } });
    const state = await stateOf(email);
    expect(state.staff).toEqual([]);
    expect(state.members).toBe(1);
    expect(state.audit.filter((r) => r.type.startsWith('identity.staff'))).toEqual([]);
  });

  it('[S17-F14] refuses a bad role, and creates nothing', async () => {
    const email = address();
    for (const role of ['ADMIN', 'super_admin', '']) {
      await expect(bootstrap(email, role as identity.StaffRole)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { field: 'role' },
      });
    }
    expect((await stateOf(email)).user).toBeNull();
  });

  it('[S17-F14] refuses an address that is not one', async () => {
    await expect(bootstrap('not-an-address')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'email' },
    });
  });

  it("[S17-F14] writes the grant's audit row once, and a row for the created account", async () => {
    const email = address();
    await bootstrap(email, 'STAFF_SUPPORT');
    await bootstrap(email, 'STAFF_SUPPORT');
    const { audit } = await stateOf(email);
    // Same transaction, so the same timestamp: compared by type, not by the order they come back in.
    expect([...audit].sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      {
        type: 'identity.staff.accountCreated',
        agency_id: PLATFORM_AGENCY_ID,
        actor_kind: 'system',
        actor_user_id: null,
        metadata: { reasonProvided: true },
      },
      {
        type: 'identity.staff.granted',
        agency_id: PLATFORM_AGENCY_ID,
        actor_kind: 'system',
        actor_user_id: null,
        metadata: { role: 'STAFF_SUPPORT', reasonProvided: true },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(email);
  });

  it('[S17-F14] the created account has no usable password', async () => {
    const [a, b] = [address(), address()];
    await bootstrap(a);
    await bootstrap(b);
    const [one, two] = [(await stateOf(a)).user, (await stateOf(b)).user];
    if (!one || !two) throw new Error('accounts not created');
    // A hash of a secret thrown away: a real hash so the login path behaves as ever, and no two alike.
    expect(one.password_hash).toMatch(/^\$argon2id\$/);
    expect(one.password_hash).not.toBe(two.password_hash);
    for (const guess of ['', a, 'Inmolink staff', 'password']) {
      expect(await verifyPassword(one.password_hash, guess)).toBe(false);
    }
    await expect(
      identity.verifyCredentials(authCtx(newId()), { email: a, password: 'correct horse battery' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('[S17-F14] a password set through the reset flow signs in, and 2FA is still required', async () => {
    const email = address();
    const { userId } = await bootstrap(email);
    await identity.requestPasswordReset(authCtx(newId()), { email });
    expect((await stateOf(email)).events.map((e) => e.type)).toEqual(['identity.passwordReset.requested']);
    const token = `reset-${newToken(16)}`;
    await withSystem('staff bootstrap test: reset token', (tx) =>
      tx.execute(
        sql`insert into auth_tokens (id, user_id, kind, token_hash, expires_at)
            values (${newId()}, ${userId}, 'PASSWORD_RESET', ${hashLinkToken(token)}, now() + interval '1 hour')`,
      ),
    );
    const password = 'another long password';
    await identity.resetPassword(authCtx(newId()), { token, password });
    const session = await identity.verifyCredentials(authCtx(newId()), { email, password });
    expect(session.mfaVerified).toBe(false);
    await expect(
      identity.issueAccessToken(authCtx(newId()), {
        userId,
        sessionVersion: session.sessionVersion,
        audience: 'api',
        mfaVerified: false,
      }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });

  it('[S17-F14] a sign-up with the address later attaches no agency', async () => {
    const email = address();
    await bootstrap(email);
    const before = await stateOf(email);
    await identity.register(authCtx(newId()), {
      email,
      password: 'correct horse battery',
      name: 'Someone',
      locale: 'en',
      accountKind: 'AGENCY',
      companyName: 'Takeover SL',
    });
    const after = await stateOf(email);
    expect(after.members).toBe(0);
    expect(after.user?.password_hash).toBe(before.user?.password_hash);
  });

  it('[S17-F14] refuses an account that was never confirmed or is disabled', async () => {
    const insert = (email: string, status: 'ACTIVE' | 'DISABLED', verified: boolean) =>
      withSystem('staff bootstrap test: account', (tx) =>
        tx.execute(
          sql`insert into users (id, email, password_hash, name, locale, status, email_verified_at)
              values (${newId()}, ${email}, 'x', 'Someone', 'en', ${status}, ${verified ? sql`now()` : null})`,
        ),
      );
    const unconfirmed = address();
    await insert(unconfirmed, 'ACTIVE', false);
    await expect(bootstrap(unconfirmed)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'email_not_confirmed' },
    });
    expect((await stateOf(unconfirmed)).staff).toEqual([]);
    const disabled = address();
    await insert(disabled, 'DISABLED', true);
    await expect(bootstrap(disabled)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'account_disabled' },
    });
    expect((await stateOf(disabled)).staff).toEqual([]);
  });

  it('[S17-F14] a confirmed account with no agency is granted, and keeps its password', async () => {
    const email = address();
    await withSystem('staff bootstrap test: account', (tx) =>
      tx.execute(
        sql`insert into users (id, email, password_hash, name, locale, status, email_verified_at)
            values (${newId()}, ${email}, 'existing-hash', 'Someone', 'en', 'ACTIVE', now())`,
      ),
    );
    const { outcome } = await bootstrap(email, 'STAFF_DATA_OPS');
    expect(outcome).toBe('granted');
    const state = await stateOf(email);
    expect(state.staff).toEqual([{ role: 'STAFF_DATA_OPS', deactivated_at: null }]);
    expect(state.user?.password_hash).toBe('existing-hash');
    expect(state.audit.map((r) => r.type)).toEqual(['identity.staff.granted']);
  });

  it('[S17-F14] refuses a different role, which is for staff:grant', async () => {
    const email = address();
    await bootstrap(email, 'STAFF_DATA_OPS');
    const before = await stateOf(email);
    await expect(bootstrap(email, 'STAFF_SUPPORT')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const state = await stateOf(email);
    expect(state.staff).toEqual([{ role: 'STAFF_DATA_OPS', deactivated_at: null }]);
    expect(state.audit).toHaveLength(before.audit.length);
  });

  it('[S17-F14] a re-run does not restore a revoked person', async () => {
    const email = address();
    await bootstrap(email, 'STAFF_SUPPORT');
    await withSystem('staff bootstrap test: revoke', (tx) => identity.revokeStaff(tx, { email }));
    const before = await stateOf(email);
    await expect(bootstrap(email, 'STAFF_SUPPORT')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const state = await stateOf(email);
    expect(state.staff).toEqual(before.staff);
    expect(state.staff[0]?.deactivated_at).not.toBeNull();
    expect(state.audit).toHaveLength(before.audit.length);
  });
});
