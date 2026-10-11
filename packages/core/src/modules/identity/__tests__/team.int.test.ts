import type { InviteMemberInput, MemberRole } from '@inmolink/contracts';
import { closeDb, withSystem, withTenant } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
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
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authCtx, type Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as identity from '../index';

/** Team management and invites on the real test database (S1-02). */

const pair = generateAccessKeyPair();
const verifier = createAccessTokenVerifier({ publicKeys: parsePublicKeys(`t1:${pair.publicKey}`) });
const log = createLogger({ service: 'identity-team-test', level: 'silent' });
const anon = () => authCtx(newId());
const PASSWORD = 'correct horse battery';
let mail: MemoryMailer;

beforeAll(async () => {
  await setupTestDb('worker');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    webUrl: 'http://web.test',
    signer: createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' }),
  });
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

beforeEach(async () => {
  mail = createMemoryMailer();
  await configureEmail(mail);
});

afterEach(() => restoreClock());

afterAll(async () => {
  await closeEmail();
  await closeDb();
});

const uniqueEmail = () => `member-${newToken(6).toLowerCase()}@example.com`;

/** A founder whose agency staff verified and who completed onboarding (app_auth can no longer see it). */
async function verifiedFounder(): Promise<Founder> {
  const founder = await createFounder();
  await withSystem('identity team test: verify agency', (tx) =>
    tx.execute(
      sql`update agencies set status = 'VERIFIED', onboarded_at = now() where agency_id = ${founder.agencyId}`,
    ),
  );
  return founder;
}

const as = <T>(m: { userId: string; agencyId: string }, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

/** Runs the invite email job for the latest `identity.invite.created` event and returns the link token. */
async function deliverInvite(inviteId: string): Promise<string> {
  const event = await withSystem('identity team test: read outbox', async (tx) => {
    const r = await tx.execute<{ id: string; agency_id: string }>(
      sql`select id, agency_id from outbox_events
           where type = 'identity.invite.created' and payload->>'inviteId' = ${inviteId}`,
    );
    return r.rows[0];
  });
  if (!event) throw new Error('no invite event');
  await identity.identityJobs.sendInviteEmail.spec.run(
    { eventId: event.id, agencyId: event.agency_id, inviteId },
    { log, jobId: event.id, attempt: 1, progress: async () => {}, signal: new AbortController().signal },
  );
  const sent = mail.sent.at(-1);
  const href = sent && /https?:\/\/\S+/.exec(sent.text)?.[0];
  const token = href ? new URL(href).searchParams.get('token') : null;
  if (!token) throw new Error('no invite link sent');
  return token;
}

async function invite(admin: { userId: string; agencyId: string }, over: Partial<InviteMemberInput> = {}) {
  const input: InviteMemberInput = { email: uniqueEmail(), role: 'AGENT', ...over };
  const dto = await as(admin, (ctx) => identity.inviteMember(ctx, input));
  return { ...dto, token: await deliverInvite(dto.id) };
}

/** Invites and accepts: a second member of `admin`'s agency. */
async function addMember(admin: Founder, role: MemberRole = 'AGENT') {
  const sent = await invite(admin, { role: role as InviteMemberInput['role'] });
  const { userId } = await identity.acceptInvite(anon(), { token: sent.token, name: 'Luis', password: PASSWORD });
  return { userId, agencyId: admin.agencyId, email: sent.email };
}

describe('invites', () => {
  it('[S1-02] invite accept joins the inviting agency with the chosen role', async () => {
    const admin = await verifiedFounder();
    const sent = await invite(admin, { role: 'AGENCY_ADMIN', locale: 'en' });
    expect(mail.sent.at(-1)).toMatchObject({ to: sent.email, tag: 'identity.invite' });
    expect(mail.sent.at(-1)?.text).toContain('Costa Homes S.L.');

    const joined = await identity.acceptInvite(anon(), { token: sent.token, name: 'Luis', password: PASSWORD });
    expect(joined.email).toBe(sent.email);
    // The link proved the email: the new member can log in at once.
    const user = await identity.verifyCredentials(anon(), { email: sent.email, password: PASSWORD });
    expect(user.id).toBe(joined.userId);
    const { token } = await identity.issueAccessToken(anon(), { ...joined, sessionVersion: 1, audience: 'api' });
    expect((await verifier.verify(token, 'api')).agency).toBe(admin.agencyId);
    const role = await as({ userId: joined.userId, agencyId: admin.agencyId }, async (ctx) => ctx.actor);
    expect(role).toMatchObject({ kind: 'user', role: 'AGENCY_ADMIN' });

    const team = await as(admin, (ctx) => identity.listMembers(ctx, { limit: 25 }));
    expect(team.items.map((m) => [m.email, m.role, m.status])).toEqual([
      [admin.email, 'AGENCY_ADMIN', 'ACTIVE'],
      [sent.email, 'AGENCY_ADMIN', 'ACTIVE'],
    ]);
    expect((await as(admin, (ctx) => identity.listInvites(ctx, { limit: 25 }))).items).toEqual([]);
  });

  it('[S1-02] invite accept — a reused token fails', async () => {
    const admin = await verifiedFounder();
    const sent = await invite(admin);
    await identity.acceptInvite(anon(), { token: sent.token, name: 'Luis', password: PASSWORD });
    await expect(
      identity.acceptInvite(anon(), { token: sent.token, name: 'Mallory', password: 'another long password' }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('[S1-02] invite accept — concurrent accepts of one link: exactly one succeeds', async () => {
    const admin = await verifiedFounder();
    const sent = await invite(admin);
    const results = await Promise.allSettled([
      identity.acceptInvite(anon(), { token: sent.token, name: 'Luis', password: PASSWORD }),
      identity.acceptInvite(anon(), { token: sent.token, name: 'Luis', password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('[S1-02] invite accept — an expired token fails (7 days)', async () => {
    const clock = useFakeClock(Date.now());
    const admin = await verifiedFounder();
    const sent = await invite(admin);
    clock.advance(7 * 24 * 60 * 60_000 + 1_000);
    await expect(
      identity.acceptInvite(anon(), { token: sent.token, name: 'Luis', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('[S1-02] invite accept — revoked, replaced and forged tokens fail', async () => {
    const admin = await verifiedFounder();
    const revoked = await invite(admin);
    await as(admin, (ctx) => identity.revokeInvite(ctx, { inviteId: revoked.id }));
    await expect(
      identity.acceptInvite(anon(), { token: revoked.token, name: 'Luis', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });

    // Inviting the same email again replaces the open invite: only the new link works.
    const first = await invite(admin);
    const second = await invite(admin, { email: first.email });
    await expect(
      identity.acceptInvite(anon(), { token: first.token, name: 'Luis', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });

    // A token pointed at another agency finds nothing there.
    const other = await verifiedFounder();
    const forged = `${other.agencyId.replaceAll('-', '')}${second.token.slice(32)}`;
    await expect(
      identity.acceptInvite(anon(), { token: forged, name: 'Luis', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await identity.acceptInvite(anon(), { token: second.token, name: 'Luis', password: PASSWORD });
  });

  it('[S1-02] an email that already has an account cannot accept; the invite stays usable', async () => {
    const admin = await verifiedFounder();
    const elsewhere = await createFounder();
    const sent = await invite(admin, { email: elsewhere.email });
    await expect(
      identity.acceptInvite(anon(), { token: sent.token, name: 'Luis', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVITE_EMAIL_IN_USE' });
    expect((await as(admin, (ctx) => identity.listInvites(ctx, { limit: 25 }))).items.map((i) => i.id)).toEqual([
      sent.id,
    ]);
  });

  it('[S1-02] inviting a current member is ALREADY_MEMBER', async () => {
    const admin = await verifiedFounder();
    await expect(
      as(admin, (ctx) => identity.inviteMember(ctx, { email: admin.email, role: 'AGENT' })),
    ).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });
  });
});

describe('review follow-ups', () => {
  it('[S1-02] the team list pages without repeats (keyset on created_at, user_id)', async () => {
    const admin = await verifiedFounder();
    await addMember(admin);
    await addMember(admin);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await as(admin, (ctx) => identity.listMembers(ctx, { limit: 1, cursor }));
      seen.push(...page.items.map((m) => m.userId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('[S1-02] invites stop working when their admin is deactivated or demoted', async () => {
    const admin = await verifiedFounder();
    const second = await addMember(admin, 'AGENCY_ADMIN');
    const byDeactivated = await invite(second, { role: 'AGENCY_ADMIN' });
    const third = await addMember(admin, 'AGENCY_ADMIN');
    const byDemoted = await invite(third, { role: 'AGENCY_ADMIN' });
    await as(admin, (ctx) => identity.deactivateMember(ctx, { userId: second.userId }));
    await as(admin, (ctx) => identity.changeMemberRole(ctx, { userId: third.userId, role: 'AGENT' }));
    for (const sent of [byDeactivated, byDemoted]) {
      await expect(
        identity.acceptInvite(anon(), { token: sent.token, name: 'Luis', password: PASSWORD }),
      ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    }
  });

  it('[S1-02] an unverified agency fills at most 5 seats with invites (VERIFICATION_REQUIRED)', async () => {
    const pending = await createFounder();
    for (let i = 0; i < 4; i++) {
      await as(pending, (ctx) => identity.inviteMember(ctx, { email: uniqueEmail(), role: 'AGENT' }));
    }
    await expect(
      as(pending, (ctx) => identity.inviteMember(ctx, { email: uniqueEmail(), role: 'AGENT' })),
    ).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
  });

  it('[S1-02] the database guard keeps an admin within their role family', async () => {
    const admin = await verifiedFounder();
    const agent = await addMember(admin);
    await expect(
      withTenant({ agencyId: admin.agencyId, userId: admin.userId }, (tx) =>
        tx.execute(sql`update agency_members set role = 'DEVELOPER_ADMIN' where user_id = ${agent.userId}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('roles', () => {
  it('[S1-02] only AGENCY_ADMIN can invite or change roles', async () => {
    const admin = await verifiedFounder();
    const agent = await addMember(admin);
    const colleague = await addMember(admin);
    await expect(
      as(agent, (ctx) => identity.inviteMember(ctx, { email: uniqueEmail(), role: 'AGENT' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      as(agent, (ctx) => identity.changeMemberRole(ctx, { userId: colleague.userId, role: 'AGENCY_ADMIN' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      as(agent, (ctx) => identity.deactivateMember(ctx, { userId: colleague.userId })),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // The database guard refuses the same write from an agent's session, whatever the service said.
    await expect(
      withTenant({ agencyId: agent.agencyId, userId: agent.userId }, (tx) =>
        tx.execute(sql`update agency_members set role = 'AGENCY_ADMIN' where user_id = ${colleague.userId}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    const promoted = await as(admin, (ctx) =>
      identity.changeMemberRole(ctx, { userId: colleague.userId, role: 'AGENCY_ADMIN' }),
    );
    expect(promoted.role).toBe('AGENCY_ADMIN');
    // Read per request: the next call already has the new role.
    expect(await as(colleague, async (ctx) => ctx.actor)).toMatchObject({ role: 'AGENCY_ADMIN' });
  });

  it('[S1-02] an agent cannot elevate itself — nor can an admin change their own role', async () => {
    const admin = await verifiedFounder();
    const agent = await addMember(admin);
    await expect(
      as(agent, (ctx) => identity.changeMemberRole(ctx, { userId: agent.userId, role: 'AGENCY_ADMIN' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      withTenant({ agencyId: agent.agencyId, userId: agent.userId }, (tx) =>
        tx.execute(sql`update agency_members set role = 'AGENCY_ADMIN' where user_id = ${agent.userId}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    // Nor by inviting itself into an admin seat, nor by inserting a membership.
    await expect(
      withTenant({ agencyId: agent.agencyId, userId: agent.userId }, (tx) =>
        tx.execute(sql`insert into agency_invites (id, agency_id, email, role, invited_by, locale, expires_at)
                       values (${newId()}, ${agent.agencyId}, ${uniqueEmail()}, 'AGENCY_ADMIN', ${agent.userId}, 'en', now() + interval '1 day')`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    await expect(
      as(admin, (ctx) => identity.changeMemberRole(ctx, { userId: admin.userId, role: 'AGENT' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as(admin, (ctx) => identity.deactivateMember(ctx, { userId: admin.userId }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await as(agent, async (ctx) => ctx.actor)).toMatchObject({ role: 'AGENT' });
  });

  it('[S1-02] an agency admin hands out agency roles only, a developer admin developer roles only', async () => {
    const admin = await verifiedFounder();
    await expect(
      as(admin, (ctx) => identity.inviteMember(ctx, { email: uniqueEmail(), role: 'DEVELOPER_AGENT' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const developer = await createFounder({ accountKind: 'DEVELOPER' });
    const sent = await as(developer, (ctx) =>
      identity.inviteMember(ctx, { email: uniqueEmail(), role: 'DEVELOPER_AGENT' }),
    );
    expect(sent.role).toBe('DEVELOPER_AGENT');
  });
});

describe('deactivation', () => {
  it('[S1-02] deactivated users cannot log in; their sessions are revoked', async () => {
    const admin = await verifiedFounder();
    const member = await addMember(admin);
    const session = { userId: member.userId, sessionVersion: 1 };
    expect(await identity.isSessionValid(anon(), session)).toBe(true);

    const dto = await as(admin, (ctx) => identity.deactivateMember(ctx, { userId: member.userId }));
    expect(dto.status).toBe('DEACTIVATED');

    // Same error as a wrong password: nothing to probe.
    await expect(identity.verifyCredentials(anon(), { email: member.email, password: PASSWORD })).rejects.toMatchObject(
      {
        code: 'INVALID_CREDENTIALS',
      },
    );
    expect(await identity.isSessionValid(anon(), session)).toBe(false);
    await expect(identity.issueAccessToken(anon(), { ...session, audience: 'api' })).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
    // A token minted before the deactivation is refused at the next request.
    await expect(as(member, async () => 'reached')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Idempotent, one event.
    await as(admin, (ctx) => identity.deactivateMember(ctx, { userId: member.userId }));
    const events = await withSystem('identity team test: read outbox', async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from outbox_events
             where type = 'identity.member.deactivated' and payload->>'userId' = ${member.userId}`,
      );
      return r.rows[0]?.n;
    });
    expect(events).toBe(1);
  });
});

describe('sign-up after S1-02', () => {
  it('[S1-02] a repeated sign-up never replaces the password of an unconfirmed account whose agency was onboarded (L3)', async () => {
    const email = uniqueEmail();
    await identity.register(anon(), {
      email,
      password: PASSWORD,
      name: 'Ana',
      locale: 'es',
      accountKind: 'AGENCY',
      companyName: 'Costa Homes S.L.',
    });
    const before = await withSystem('identity team test: read user', async (tx) => {
      const r = await tx.execute<{ id: string; password_hash: string }>(
        sql`select id, password_hash from users where email = ${email}`,
      );
      return r.rows[0];
    });
    if (!before) throw new Error('no user');
    await withSystem('identity team test: onboard agency', (tx) =>
      tx.execute(sql`update agencies set onboarded_at = now()
                      where agency_id = (select agency_id from agency_members where user_id = ${before.id})`),
    );
    await identity.register(anon(), {
      email,
      password: 'attacker chosen password',
      name: 'Mallory',
      locale: 'en',
      accountKind: 'AGENCY',
      companyName: 'Evil S.L.',
    });
    const after = await withSystem('identity team test: read user', async (tx) => {
      const r = await tx.execute<{ password_hash: string; name: string; type: string }>(
        sql`select u.password_hash, u.name,
                   (select o.type from outbox_events o where o.payload->>'userId' = u.id::text
                     order by o.created_at desc, o.id desc limit 1) as type
              from users u where u.id = ${before.id}`,
      );
      return r.rows[0];
    });
    expect(after).toMatchObject({
      password_hash: before.password_hash,
      name: 'Ana',
      type: 'identity.signup.duplicated',
    });
  });
});
