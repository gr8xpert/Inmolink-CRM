import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newToken } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authCtx, type Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as identity from '../index';
import { hashLinkToken } from '../service';

/** Security events of the identity module land in the audit log (S1-08), in the transaction of the change. */

const PASSWORD = 'correct horse battery';

beforeAll(async () => {
  await setupTestDb('worker');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    webUrl: 'http://web.test',
    apiKeyEnv: 'test',
  });
  // Re-sent confirmation links are throttled per user in redis-cache (S1-F4).
  await configureCache({ url: process.env.REDIS_CACHE_URL, commandTimeoutMs: 2_000 });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

afterAll(async () => {
  await closeCache();
  await closeRateLimit();
  await closeDb();
});

interface AuditRow {
  agency_id: string;
  type: string;
  actor_kind: string;
  actor_user_id: string | null;
  impersonated_by: string | null;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
}

/** Audit rows about a target (user, key), oldest first. */
const auditOf = (targetId: string) =>
  withSystem('audit test: read audit log', async (tx) => {
    const r = await tx.execute(
      sql`select agency_id, type, actor_kind, actor_user_id, impersonated_by, target_type, target_id, request_id, metadata
            from audit_logs where target_id = ${targetId} order by occurred_at, id`,
    );
    return r.rows as unknown as AuditRow[];
  });

const as = <T>(
  m: { userId: string; agencyId: string },
  fn: (ctx: Ctx) => Promise<T>,
  over: { impersonatedBy?: string; requestId?: string } = {},
) =>
  withMemberCtx(
    { userId: m.userId, agencyId: m.agencyId, requestId: over.requestId ?? newId(), locale: 'en' },
    async (ctx) => fn(over.impersonatedBy ? await impersonatedCtx(ctx, over.impersonatedBy) : ctx),
  );

/** A second member of the founder's agency, written as the invite flow would leave it. */
async function addMember(founder: Founder, role = 'AGENT'): Promise<string> {
  const id = newId();
  const email = `member-${newToken(6).toLowerCase()}@example.com`;
  await withSystem('audit test: add member', async (tx) => {
    await tx.execute(
      sql`insert into users (id, email, password_hash, name, locale, email_verified_at)
          values (${id}, ${email}, 'x', 'Luis', 'es', now())`,
    );
    await tx.execute(
      sql`insert into agency_members (agency_id, user_id, role, name, email)
          values (${founder.agencyId}, ${id}, ${role}, 'Luis', ${email})`,
    );
  });
  return id;
}

describe('identity audit log', () => {
  it('[S1-08] logins are audited: success and failures on an existing account, under its agency, with no secrets', async () => {
    const founder = await createFounder();
    const requestId = newId();
    await expect(
      identity.verifyCredentials(authCtx(requestId), { email: founder.email, password: 'wrong password!' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await identity.verifyCredentials(authCtx(newId()), { email: founder.email, password: PASSWORD });

    const rows = await auditOf(founder.userId);
    expect(rows.map((r) => [r.type, r.actor_kind, r.actor_user_id])).toEqual([
      ['identity.login.failed', 'anonymous', null],
      ['identity.login.succeeded', 'user', founder.userId],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ agency_id: founder.agencyId, target_type: 'user', impersonated_by: null });
    }
    expect(rows[0]?.request_id).toBe(requestId);
    expect(rows[0]?.metadata).toEqual({ reason: 'invalid_password' });
    // The password step: an agency admin must still pass 2FA (S1-04).
    expect(rows[1]?.metadata).toEqual({ secondFactor: 'required' });
    // Neither the password nor the email is ever written.
    const text = JSON.stringify(rows);
    expect(text).not.toContain('wrong password');
    expect(text).not.toContain(founder.email);
  });

  it('[S1-08] a deactivated member’s and an unconfirmed account’s logins are audited as failures; an unknown email is not', async () => {
    const founder = await createFounder();
    const member = await addMember(founder);
    await as(founder, (ctx) => identity.deactivateMember(ctx, { userId: member }));
    await withSystem('audit test: set password', (tx) =>
      tx.execute(sql`update users set password_hash = (select password_hash from users where id = ${founder.userId})
                      where id = ${member}`),
    );
    const email = await withSystem('audit test: email', async (tx) => {
      const r = await tx.execute<{ email: string }>(sql`select email from users where id = ${member}`);
      return r.rows[0]?.email as string;
    });
    await expect(identity.verifyCredentials(authCtx(newId()), { email, password: PASSWORD })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect((await auditOf(member)).filter((r) => r.type === 'identity.login.failed').map((r) => r.metadata)).toEqual([
      { reason: 'member_deactivated' },
    ]);

    const unconfirmed = await createFounder();
    await withSystem('audit test: unconfirm', (tx) =>
      tx.execute(sql`update users set email_verified_at = null where id = ${unconfirmed.userId}`),
    );
    await expect(
      identity.verifyCredentials(authCtx(newId()), { email: unconfirmed.email, password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect((await auditOf(unconfirmed.userId)).map((r) => [r.type, r.metadata])).toEqual([
      ['identity.login.failed', { reason: 'email_not_verified' }],
    ]);

    const unknown = `nobody-${newToken(6).toLowerCase()}@example.com`;
    await expect(
      identity.verifyCredentials(authCtx(newId()), { email: unknown, password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const leaked = await withSystem('audit test: unknown email', async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from audit_logs where metadata::text like ${`%${unknown}%`}`,
      );
      return r.rows[0]?.n ?? 0;
    });
    expect(leaked).toBe(0);
  });

  it('[S1-08] role changes and deactivations record the admin and the request (S1-09: never while impersonated)', async () => {
    const founder = await createFounder();
    const member = await addMember(founder);
    const staffId = newId();
    const requestId = newId();
    await expect(
      as(founder, (ctx) => identity.changeMemberRole(ctx, { userId: member, role: 'AGENCY_ADMIN' }), {
        impersonatedBy: staffId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await as(founder, (ctx) => identity.changeMemberRole(ctx, { userId: member, role: 'AGENCY_ADMIN' }), {
      requestId,
    });
    await as(founder, (ctx) => identity.deactivateMember(ctx, { userId: member }));

    const rows = await auditOf(member);
    expect(rows).toEqual([
      {
        agency_id: founder.agencyId,
        type: 'identity.member.roleChanged',
        actor_kind: 'user',
        actor_user_id: founder.userId,
        impersonated_by: null,
        target_type: 'user',
        target_id: member,
        request_id: requestId,
        metadata: { from: 'AGENT', to: 'AGENCY_ADMIN' },
      },
      expect.objectContaining({
        type: 'identity.member.deactivated',
        actor_user_id: founder.userId,
        impersonated_by: null,
      }),
    ]);
  });

  it('[S1-08] API key creation, rotation and revocation are audited with the prefix, never the secret', async () => {
    const founder = await createFounder();
    await withSystem('audit test: verify agency', (tx) =>
      tx.execute(
        sql`update agencies set status = 'VERIFIED', onboarded_at = now() where agency_id = ${founder.agencyId}`,
      ),
    );
    const created = await as(founder, (ctx) =>
      identity.createApiKey(ctx, { name: 'Site', kind: 'SECRET', scopes: ['listings:read'], allowedOrigins: [] }),
    );
    const rotated = await as(founder, (ctx) => identity.rotateApiKey(ctx, { keyId: created.key.id }));
    await as(founder, (ctx) => identity.revokeApiKey(ctx, { keyId: created.key.id }));

    const rows = await auditOf(created.key.id);
    expect(rows.map((r) => [r.type, r.actor_user_id, r.target_type])).toEqual([
      ['identity.apiKey.created', founder.userId, 'apiKey'],
      ['identity.apiKey.rotated', founder.userId, 'apiKey'],
      ['identity.apiKey.revoked', founder.userId, 'apiKey'],
    ]);
    expect(rows[0]?.metadata).toEqual({ kind: 'SECRET', prefix: created.key.prefix, scopes: ['listings:read'] });
    expect(rows[1]?.metadata).toEqual({ prefix: rotated.key.prefix, retiredPrefix: created.key.prefix });
    expect(rows[2]?.metadata).toEqual({ prefix: rotated.key.prefix });
    const text = JSON.stringify(rows);
    for (const secret of [created.secret, rotated.secret]) expect(text).not.toContain(secret.split('_').at(-1));
  });

  it('[S1-08] a staff user’s login is a platform row (no agency)', async () => {
    const id = newId();
    const founder = await createFounder();
    await withSystem('audit test: staff user', async (tx) => {
      await tx.execute(
        sql`insert into users (id, email, password_hash, name, locale, email_verified_at)
            select ${id}, ${`staff-${newToken(6).toLowerCase()}@staff.inmolink.test`}, password_hash, 'Support', 'en', now()
              from users where id = ${founder.userId}`,
      );
      await tx.execute(sql`insert into staff_users (user_id, role) values (${id}, 'STAFF_SUPPORT')`);
    });
    const email = await withSystem('audit test: staff email', async (tx) => {
      const r = await tx.execute<{ email: string }>(sql`select email from users where id = ${id}`);
      return r.rows[0]?.email as string;
    });
    await identity.verifyCredentials(authCtx(newId()), { email, password: PASSWORD });
    expect(await auditOf(id)).toEqual([
      expect.objectContaining({ type: 'identity.login.succeeded', agency_id: PLATFORM_AGENCY_ID, actor_user_id: id }),
    ]);
  });
  it('[S1-08] staff grants and revocations are platform rows written by the system, with the role and no reason text', async () => {
    const id = newId();
    const email = `ops-${newToken(6).toLowerCase()}@staff.inmolink.test`;
    await withSystem('audit test: staff account', (tx) =>
      tx.execute(
        sql`insert into users (id, email, password_hash, name, locale, email_verified_at)
            values (${id}, ${email}, 'x', 'Ops', 'en', now())`,
      ),
    );
    await withSystem('ops.staff.grant: onboarding Maria to support', (tx) =>
      identity.grantStaff(tx, { email, role: 'STAFF_SUPPORT' }),
    );
    await withSystem('ops.staff.revoke: left the company', (tx) => identity.revokeStaff(tx, { email }));
    // Revoking again changes nothing and records nothing.
    expect(await withSystem('ops.staff.revoke: again', (tx) => identity.revokeStaff(tx, { email }))).toBe(false);
    const rows = await auditOf(id);
    expect(rows.map((r) => [r.type, r.agency_id, r.actor_kind, r.actor_user_id, r.metadata])).toEqual([
      ['identity.staff.granted', PLATFORM_AGENCY_ID, 'system', null, { role: 'STAFF_SUPPORT', reasonProvided: true }],
      ['identity.staff.revoked', PLATFORM_AGENCY_ID, 'system', null, { reasonProvided: true }],
    ]);
    expect(JSON.stringify(rows)).not.toContain('Maria');
  });

  it('[S1-08] a password reset is audited under the user’s agency', async () => {
    const founder = await createFounder();
    const token = `reset-${newToken(16)}`;
    await withSystem('audit test: reset token', (tx) =>
      tx.execute(
        sql`insert into auth_tokens (id, user_id, kind, token_hash, expires_at)
            values (${newId()}, ${founder.userId}, 'PASSWORD_RESET', ${hashLinkToken(token)}, now() + interval '1 hour')`,
      ),
    );
    await identity.resetPassword(authCtx(newId()), { token, password: 'another long password' });
    expect((await auditOf(founder.userId)).map((r) => [r.type, r.agency_id, r.actor_user_id])).toEqual([
      ['identity.password.reset', founder.agencyId, founder.userId],
    ]);
  });
});
