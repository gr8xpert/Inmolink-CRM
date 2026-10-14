import { closeDb, withAuth, withStaff, withSystem, withTenant } from '@inmolink/db';
import { createStaffUser, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey, newToken } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authCtx, type Ctx, type StaffCtx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { listStaffAuditLog } from '../../../staff-audit';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as compliance from '../../compliance';
import * as identity from '../index';

/** Staff impersonation on the real test database (S1-09): sessions, the mint, the request ctx, RLS and guard. */

const pair = generateAccessKeyPair();
const verifier = createAccessTokenVerifier({ publicKeys: parsePublicKeys(`t1:${pair.publicKey}`) });
const REASON = 'Ticket 4711: the agency cannot see its invites';

beforeAll(async () => {
  await setupTestDb('worker');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    webUrl: 'http://web.test',
    signer: createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' }),
    keyring: createKeyring({ keys: { t1: generateKey() }, activeKeyId: 't1' }),
  });
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

afterAll(async () => {
  await closeDb();
});

const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'impersonation test' }, fn);

const start = (staffUserId: string, f: { agencyId: string; userId: string }, minutes = 30) =>
  asStaff(staffUserId, (ctx) =>
    identity.startImpersonation(ctx, { agencyId: f.agencyId, userId: f.userId, reason: REASON, minutes }),
  );

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string; cause?: { code?: string } }) => err.code ?? err.cause?.code ?? String(err),
  );

/** The request ctx an impersonation token builds in the API (`withCtx`). */
const asImpersonated = <T>(
  f: { agencyId: string; userId: string },
  s: { id: string; staffUserId: string; sessionVersion?: number },
  fn: (ctx: Ctx) => Promise<T>,
) =>
  withMemberCtx(
    {
      userId: f.userId,
      agencyId: f.agencyId,
      requestId: newId(),
      impersonation: { id: s.id, staffUserId: s.staffUserId, sessionVersion: s.sessionVersion ?? 1 },
    },
    fn,
  );

const mint = (
  staffUserId: string,
  impersonationId: string,
  over: { mfaVerified?: boolean; audience?: 'api' | 'realtime' } = {},
) =>
  identity.issueAccessToken(authCtx(newId()), {
    userId: staffUserId,
    sessionVersion: 1,
    audience: over.audience ?? 'api',
    mfaVerified: over.mfaVerified ?? true,
    impersonationId,
  });

/** A second member of the founder's agency, written as the invite flow would leave it. */
async function addMember(founder: Founder, opts: { deactivated?: boolean } = {}): Promise<string> {
  const id = newId();
  const email = `member-${newToken(6).toLowerCase()}@example.com`;
  await withSystem('impersonation test: add member', async (tx) => {
    await tx.execute(
      sql`insert into users (id, email, password_hash, name, locale, email_verified_at)
          values (${id}, ${email}, 'x', 'Luis', 'es', now())`,
    );
    await tx.execute(
      sql`insert into agency_members (agency_id, user_id, role, name, email, deactivated_at)
          values (${founder.agencyId}, ${id}, 'AGENT', 'Luis', ${email}, ${opts.deactivated ? new Date() : null})`,
    );
  });
  return id;
}

const auditRows = (agencyId: string, type: string) =>
  withSystem('impersonation test: audit rows', async (tx) => {
    const r = await tx.execute<{
      actor_kind: string;
      actor_user_id: string | null;
      impersonated_by: string | null;
      target_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      sql`select actor_kind, actor_user_id, impersonated_by, target_id, metadata from audit_logs
           where agency_id = ${agencyId} and type = ${type} order by occurred_at, id`,
    );
    return r.rows;
  });

describe('staff impersonation', () => {
  it('[S1-09] support starts a session for an active member, with a reason, at most 60 minutes; audited without the reason', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await start(support.userId, f, 20);
    expect(session).toMatchObject({ agencyId: f.agencyId, userId: f.userId, userName: 'Ana' });
    const minutes = (Date.parse(session.expiresAt) - Date.parse(session.startedAt)) / 60_000;
    expect(minutes).toBe(20);
    expect(await auditRows(f.agencyId, 'staff.impersonation.started')).toEqual([
      {
        actor_kind: 'staff',
        actor_user_id: support.userId,
        impersonated_by: null,
        target_id: f.userId,
        metadata: { impersonationId: session.id, minutes: 20, reasonProvided: true },
      },
    ]);
    // The staff member sees it as their open session (the web banner).
    expect(await asStaff(support.userId, (ctx) => identity.getStaffMe(ctx))).toMatchObject({
      role: 'STAFF_SUPPORT',
      impersonation: { id: session.id },
    });

    // One open session per staff member: a new start ends the previous one (audited).
    const other = await createFounder();
    const next = await start(support.userId, other);
    expect(await auditRows(f.agencyId, 'staff.impersonation.ended')).toEqual([
      expect.objectContaining({
        actor_user_id: support.userId,
        metadata: { impersonationId: session.id, cause: 'replaced' },
      }),
    ]);
    expect(await refusal(mint(support.userId, session.id))).toBe('IMPERSONATION_ENDED');
    expect(await asStaff(support.userId, (ctx) => identity.getStaffMe(ctx))).toMatchObject({
      impersonation: { id: next.id, agencyId: other.agencyId },
    });
  });

  it('[S1-09] only an active member of an agency that is not suspended; data ops may not impersonate', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const gone = await addMember(f, { deactivated: true });
    const stranger = await createFounder();
    expect(await refusal(start(support.userId, { agencyId: f.agencyId, userId: gone }))).toBe(
      'IMPERSONATION_TARGET_INVALID',
    );
    expect(await refusal(start(support.userId, { agencyId: f.agencyId, userId: stranger.userId }))).toBe(
      'IMPERSONATION_TARGET_INVALID',
    );
    expect(await refusal(start(support.userId, { agencyId: newId(), userId: f.userId }))).toBe('NOT_FOUND');
    await setAgencyStatus(f.agencyId, 'SUSPENDED');
    expect(await refusal(start(support.userId, f))).toBe('IMPERSONATION_TARGET_INVALID');
    const ops = await createStaffUser('STAFF_DATA_OPS');
    expect(await refusal(start(ops.userId, stranger))).toBe('FORBIDDEN');
  });

  it('[S1-09] the mint: only the staff member who owns the live session, after 2FA, for the API; the token names both', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await start(support.userId, f);
    const { token } = await mint(support.userId, session.id);
    expect(await verifier.verify(token, 'api')).toMatchObject({
      sub: f.userId,
      agency: f.agencyId,
      act: support.userId,
      imp: session.id,
    });
    expect(await refusal(mint(support.userId, session.id, { mfaVerified: false }))).toBe('MFA_REQUIRED');
    expect(await refusal(mint(support.userId, session.id, { audience: 'realtime' }))).toBe('FORBIDDEN');
    const colleague = await createStaffUser('STAFF_SUPPORT');
    expect(await refusal(mint(colleague.userId, session.id))).toBe('IMPERSONATION_ENDED');
    // A tenant session cannot mint one, even naming a real session.
    expect(await refusal(mint(f.userId, session.id))).toBe('FORBIDDEN');
  });

  it('[S1-09] every action during impersonation records both the staff member and the impersonated user', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await start(support.userId, f);
    const s = { id: session.id, staffUserId: support.userId };

    // What staff may change while impersonating — the profile — is audited and evented with both people.
    const before = await asImpersonated(f, s, (ctx) => agencies.getAgencyProfile(ctx));
    await asImpersonated(f, s, (ctx) =>
      agencies.updateAgencyProfile(ctx, {
        version: before.version,
        primaryColor: '#0a7cff',
        accentColor: null,
        contactEmail: null,
        contactPhone: null,
        websiteUrl: null,
        translations: [],
      }),
    );
    const events = await withSystem('impersonation test: events', async (tx) =>
      (
        await tx.execute<{ payload: Record<string, unknown> }>(
          sql`select payload from outbox_events where agency_id = ${f.agencyId} and type = 'agencies.profile.updated'`,
        )
      ).rows.map((r) => r.payload),
    );
    expect(events).toEqual([expect.objectContaining({ actorUserId: f.userId, impersonatedBy: support.userId })]);
    expect(await auditRows(f.agencyId, 'agencies.profile.updated')).toEqual([
      expect.objectContaining({ actor_kind: 'user', actor_user_id: f.userId, impersonated_by: support.userId }),
    ]);
  });

  it('[S1-09] team management is refused while impersonating: invite, role change, deactivate, revoke invite', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await start(support.userId, f);
    const s = { id: session.id, staffUserId: support.userId };
    const member = await addMember(f);
    const invite = await withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId() }, (ctx) =>
      identity.inviteMember(ctx, { email: `agent-${newToken(6).toLowerCase()}@example.com`, role: 'AGENT' }),
    );
    const attempts: [string, (ctx: Ctx) => Promise<unknown>][] = [
      // An invite to the staff member's own email would outlive the session.
      ['invite', (ctx) => identity.inviteMember(ctx, { email: 'me@staff.inmolink.test', role: 'AGENCY_ADMIN' })],
      ['role', (ctx) => identity.changeMemberRole(ctx, { userId: member, role: 'AGENCY_ADMIN' })],
      ['deactivate', (ctx) => identity.deactivateMember(ctx, { userId: member })],
      ['revokeInvite', (ctx) => identity.revokeInvite(ctx, { inviteId: invite.id })],
      ['listInvites', (ctx) => identity.listInvites(ctx, { limit: 10 })],
    ];
    for (const [name, attempt] of attempts) {
      expect(await refusal(asImpersonated(f, s, attempt)), name).toBe('FORBIDDEN');
    }
    // Reading the team stays possible.
    expect((await asImpersonated(f, s, (ctx) => identity.listMembers(ctx, { limit: 10 }))).items).toHaveLength(2);
  });

  it('[S1-09] other forbidden actions through the real session: API keys, preferred add, company details', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await start(support.userId, f);
    const s = { id: session.id, staffUserId: support.userId };
    expect(
      await refusal(
        asImpersonated(f, s, (ctx) =>
          identity.createApiKey(ctx, { name: 'Site', kind: 'SECRET', scopes: ['listings:read'], allowedOrigins: [] }),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(await refusal(asImpersonated(f, s, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: newId() })))).toBe(
      'FORBIDDEN',
    );
    expect(await refusal(asImpersonated(f, s, (ctx) => agencies.submitVerification(ctx, { version: 1 })))).toBe(
      'FORBIDDEN',
    );
  });

  it('[S1-09] concurrent starts by one staff member both succeed in turn; one session stays open', async () => {
    const f = await createFounder();
    const g = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const results = await Promise.allSettled([start(support.userId, f), start(support.userId, g)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const open = await withSystem(
      'impersonation test: open sessions',
      async (tx) =>
        (
          await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from staff_impersonations where staff_user_id = ${support.userId} and ended_at is null`,
          )
        ).rows[0]?.n,
    );
    expect(open).toBe(1);
  });

  it('[S1-09] a downgraded or withdrawn staff member, or a target who is staff, stops the session at once', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await start(support.userId, f);
    const read = () =>
      refusal(asImpersonated(f, { id: session.id, staffUserId: support.userId }, (ctx) => agencies.getMyAgency(ctx)));
    expect(await read()).toBe('resolved');
    // Downgraded directly in the table (not through the grant script): the request check re-reads the role.
    const setRole = (role: string, deactivated = false) =>
      withSystem('impersonation test: staff role', (tx) =>
        tx.execute(
          sql`update staff_users set role = ${role}::staff_role, deactivated_at = ${deactivated ? new Date() : null}
               where user_id = ${support.userId}`,
        ),
      );
    await setRole('STAFF_DATA_OPS');
    expect(await read()).toBe('IMPERSONATION_ENDED');
    expect(await refusal(mint(support.userId, session.id))).toBe('FORBIDDEN');
    await setRole('STAFF_SUPPORT', true);
    expect(await read()).toBe('IMPERSONATION_ENDED');
    await setRole('STAFF_SUPPORT');
    expect(await read()).toBe('resolved');
    // The grant script ends open sessions on any role change.
    await withSystem('impersonation test: regrant', (tx) =>
      identity.grantStaff(tx, { email: support.email, role: 'SUPER_ADMIN' }),
    );
    expect(await read()).toBe('IMPERSONATION_ENDED');

    // A target who is (or becomes) staff: the mint refuses to act as them.
    const next = await start(support.userId, f);
    await withSystem('impersonation test: founder becomes staff', (tx) =>
      tx.execute(sql`insert into staff_users (user_id, role) values (${f.userId}, 'STAFF_SUPPORT')`),
    );
    expect(await refusal(mint(support.userId, next.id))).toBe('IMPERSONATION_TARGET_INVALID');
  });

  it('[S1-F9] disabling the staff login, or bumping its session version, ends the session on the next request', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await start(support.userId, f);
    const read = (sessionVersion = 1) =>
      refusal(
        asImpersonated(f, { id: session.id, staffUserId: support.userId, sessionVersion }, (ctx) =>
          agencies.getMyAgency(ctx),
        ),
      );
    const setLogin = (set: ReturnType<typeof sql>) =>
      withSystem('impersonation test: staff login', (tx) =>
        tx.execute(sql`update users set ${set} where id = ${support.userId}`),
      );
    expect(await read()).toBe('resolved');

    // "Sign out everywhere", a password reset or a 2FA change bump the version: the old token stops at once.
    await setLogin(sql`session_version = session_version + 1`);
    expect(await read(1)).toBe('IMPERSONATION_ENDED');
    expect(await read(2)).toBe('resolved');

    await setLogin(sql`status = 'DISABLED'`);
    expect(await read(2)).toBe('IMPERSONATION_ENDED');
    await setLogin(sql`status = 'ACTIVE'`);
    expect(await read(2)).toBe('resolved');
  });

  it('[S1-F9] agency admins see when staff acted and why; agents, other agencies and impersonators do not', async () => {
    const f = await createFounder();
    const other = await createFounder();
    const agent = await addMember(f);
    const support = await createStaffUser('STAFF_SUPPORT');
    const asAdmin = <T>(who: { agencyId: string; userId: string }, fn: (ctx: Ctx) => Promise<T>) =>
      withMemberCtx({ userId: who.userId, agencyId: who.agencyId, requestId: newId() }, fn);
    const list = (who: { agencyId: string; userId: string }) =>
      asAdmin(who, (ctx) => identity.listStaffAccess(ctx, { limit: 25 }));

    const session = await start(support.userId, { agencyId: f.agencyId, userId: agent });
    const page = await list(f);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: session.id,
      memberUserId: agent,
      memberName: 'Luis',
      reason: REASON,
      status: 'ACTIVE',
      endedAt: null,
    });
    // Staff identities stay with Inmolink.
    expect(JSON.stringify(page)).not.toContain(support.userId);
    expect(await list(other).then((p) => p.items)).toEqual([]);
    // An agent cannot read it; neither can staff acting as the admin.
    expect(
      await refusal(
        asAdmin({ agencyId: f.agencyId, userId: agent }, (ctx) => identity.listStaffAccess(ctx, { limit: 25 })),
      ),
    ).toBe('FORBIDDEN');
    const asAdminSession = await start(support.userId, f);
    expect(
      await refusal(
        asImpersonated(f, { id: asAdminSession.id, staffUserId: support.userId }, (ctx) =>
          identity.listStaffAccess(ctx, { limit: 25 }),
        ),
      ),
    ).toBe('FORBIDDEN');
    const after = await list(f);
    expect(after.items.map((i) => [i.id, i.status])).toEqual([
      [asAdminSession.id, 'ACTIVE'],
      [session.id, 'ENDED'],
    ]);
  });

  it('[S1-F9] the staff access record pages without skipping sessions started in the same millisecond', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const ids = [newId(), newId()];
    await withSystem('impersonation test: same-millisecond sessions', async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.execute(
          sql`insert into staff_impersonations (id, agency_id, staff_user_id, target_user_id, reason, started_at, expires_at, ended_at)
              values (${id}, ${f.agencyId}, ${support.userId}, ${f.userId}, ${REASON},
                      ${`2026-01-01T10:00:00.12300${i + 1}Z`}::timestamptz, '2026-01-01T10:30:00Z', '2026-01-01T10:10:00Z')`,
        );
      }
    });
    const page = (cursor?: string) =>
      withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId() }, (ctx) =>
        identity.listStaffAccess(ctx, { limit: 1, ...(cursor ? { cursor } : {}) }),
      );
    const first = await page();
    expect(first.nextCursor).not.toBeNull();
    const second = await page(first.nextCursor ?? undefined);
    expect([...first.items, ...second.items].map((i) => i.id).sort()).toEqual([...ids].sort());
    expect(second.items[0]?.status).toBe('ENDED');
  });

  it('[S1-F9] a super admin lists and ends another staff member’s session; support cannot', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const colleague = await createStaffUser('STAFF_SUPPORT');
    const admin = await createStaffUser('SUPER_ADMIN');
    const session = await start(support.userId, f);
    const read = () =>
      refusal(asImpersonated(f, { id: session.id, staffUserId: support.userId }, (ctx) => agencies.getMyAgency(ctx)));
    expect(await read()).toBe('resolved');

    expect(await refusal(asStaff(colleague.userId, (ctx) => identity.listLiveImpersonations(ctx)))).toBe('FORBIDDEN');
    expect(await refusal(asStaff(colleague.userId, (ctx) => identity.endImpersonation(ctx, { id: session.id })))).toBe(
      'NOT_FOUND',
    );
    expect(await read()).toBe('resolved');

    const live = await asStaff(admin.userId, (ctx) => identity.listLiveImpersonations(ctx));
    expect(live.items.find((s) => s.id === session.id)).toMatchObject({
      staffUserId: support.userId,
      userId: f.userId,
      agencyName: 'Costa Homes S.L.',
      userName: 'Ana',
    });
    await asStaff(admin.userId, (ctx) => identity.endImpersonation(ctx, { id: session.id }));
    expect(await read()).toBe('IMPERSONATION_ENDED');
    expect(await refusal(asStaff(admin.userId, (ctx) => identity.endImpersonation(ctx, { id: session.id })))).toBe(
      'NOT_FOUND',
    );
    const ended = await auditRows(f.agencyId, 'staff.impersonation.ended');
    expect(ended.find((r) => r.metadata.impersonationId === session.id)).toMatchObject({
      actor_kind: 'staff',
      actor_user_id: admin.userId,
      metadata: { cause: 'endedBySuperAdmin', staffUserId: support.userId },
    });
  });

  it('[S1-F9] the staff audit viewer shows names instead of ids', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const admin = await createStaffUser('SUPER_ADMIN');
    await start(support.userId, f);
    const page = await asStaff(admin.userId, (ctx) =>
      listStaffAuditLog(ctx, { agencyId: f.agencyId, type: 'staff.impersonation.started', limit: 25 }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      agencyName: 'Costa Homes S.L.',
      actor: { kind: 'staff', userId: support.userId },
      target: { type: 'user', id: f.userId, name: 'Ana' },
    });
    expect(typeof page.items[0]?.actor.userName).toBe('string');
  });

  it('[S1-09] an ended, expired or revoked session stops working on the next request', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    let session = await start(support.userId, f);
    const read = (id: string) =>
      refusal(asImpersonated(f, { id, staffUserId: support.userId }, (ctx) => agencies.getMyAgency(ctx)));
    expect(await read(session.id)).toBe('resolved');
    // Another staff member's id, or another session id, never passes.
    expect(
      await refusal(asImpersonated(f, { id: session.id, staffUserId: newId() }, (ctx) => agencies.getMyAgency(ctx))),
    ).toBe('IMPERSONATION_ENDED');
    expect(await read(newId())).toBe('IMPERSONATION_ENDED');

    // Ended by the staff member (audited), then ending again is NOT_FOUND.
    await asStaff(support.userId, (ctx) => identity.endImpersonation(ctx, { id: session.id }));
    expect(await read(session.id)).toBe('IMPERSONATION_ENDED');
    expect(await refusal(asStaff(support.userId, (ctx) => identity.endImpersonation(ctx, { id: session.id })))).toBe(
      'NOT_FOUND',
    );
    expect(await auditRows(f.agencyId, 'staff.impersonation.ended')).toEqual([
      expect.objectContaining({
        actor_user_id: support.userId,
        target_id: f.userId,
        metadata: { impersonationId: session.id, cause: 'ended' },
      }),
    ]);

    // Expired (time moved past `expires_at`).
    session = await start(support.userId, f);
    await withSystem('impersonation test: expire', (tx) =>
      tx.execute(
        sql`update staff_impersonations set started_at = now() - interval '40 minutes', expires_at = now() - interval '10 minutes'
             where id = ${session.id}`,
      ),
    );
    expect(await read(session.id)).toBe('IMPERSONATION_ENDED');
    expect(await refusal(mint(support.userId, session.id))).toBe('IMPERSONATION_ENDED');

    // Revoked staff access ends the open session at once.
    session = await start(support.userId, f);
    expect(await read(session.id)).toBe('resolved');
    await withSystem('impersonation test: revoke', (tx) => identity.revokeStaff(tx, { email: support.email }));
    expect(await read(session.id)).toBe('IMPERSONATION_ENDED');
    expect(await auditRows(f.agencyId, 'staff.impersonation.ended')).toContainEqual(
      expect.objectContaining({
        actor_kind: 'system',
        metadata: { impersonationId: session.id, staffUserId: support.userId, cause: 'staffRevoked' },
      }),
    );
  });

  it('[S1-09] RLS: an impersonated transaction’s audit rows must name the staff member, and only then', async () => {
    const f = await createFounder();
    const staffId = newId();
    const insert = (impersonatedBy: string | null, setting?: string) =>
      refusal(
        withTenant({ agencyId: f.agencyId, userId: f.userId, ...(setting ? { impersonatedBy: setting } : {}) }, (tx) =>
          tx.execute(
            sql`insert into audit_logs (id, agency_id, type, actor_kind, actor_user_id, impersonated_by)
                values (${newId()}, ${f.agencyId}, 'identity.member.invited', 'user', ${f.userId}, ${impersonatedBy})`,
          ),
        ),
      );
    expect(await insert(null)).toBe('resolved');
    expect(await insert(staffId, staffId)).toBe('resolved');
    expect(await insert(null, staffId)).toBe('42501'); // impersonated, but the row hides the staff member
    expect(await insert(staffId)).toBe('42501'); // not impersonated, but the row names someone
    expect(await insert(newId(), staffId)).toBe('42501'); // names another staff member
  });

  it('[S1-F10] RLS: an admin and the targeted member read a session, another member does not; nobody reads staff_user_id', async () => {
    const f = await createFounder(); // AGENCY_ADMIN
    const target = await addMember(f);
    const colleague = await addMember(f);
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await start(support.userId, { agencyId: f.agencyId, userId: target });
    const as = (userId: string | undefined) => ({ agencyId: f.agencyId, ...(userId ? { userId } : {}) });
    const visibleTo = (userId: string | undefined) =>
      withTenant(as(userId), async (tx) => {
        const r = await tx.execute<{ id: string }>(
          sql`select id from staff_impersonations where agency_id = ${f.agencyId}`,
        );
        return r.rows.map((row) => row.id);
      });
    expect(await visibleTo(f.userId)).toEqual([session.id]); // admin of the agency
    expect(await visibleTo(target)).toEqual([session.id]); // the member it targets
    expect(await visibleTo(colleague)).toEqual([]); // another agent
    expect(await visibleTo(undefined)).toEqual([]); // no user in the transaction
    // The reason is a column of the same row: the colleague gets it from neither a filter nor a join.
    const reasons = await withTenant(as(colleague), (tx) =>
      tx.execute(sql`select reason from staff_impersonations where id = ${session.id}`),
    );
    expect(reasons.rows).toEqual([]);
    // staff_user_id is unreadable to every member, admin and target included: select, star, filter, order.
    for (const userId of [f.userId, target, colleague]) {
      for (const query of [
        sql`select staff_user_id from staff_impersonations where id = ${session.id}`,
        sql`select * from staff_impersonations where id = ${session.id}`,
        sql`select id from staff_impersonations where staff_user_id = ${support.userId}`,
        sql`select id from staff_impersonations where id = ${session.id} order by staff_user_id`,
      ]) {
        expect(await refusal(withTenant(as(userId), (tx) => tx.execute(query)))).toBe('42501');
      }
    }
    // The per-request check still works as the target, and an admin reads the access record.
    expect(
      await asImpersonated(
        { agencyId: f.agencyId, userId: target },
        { id: session.id, staffUserId: support.userId },
        async (ctx) => (ctx.actor.kind === 'user' ? ctx.actor.userId : null),
      ),
    ).toBe(target);
    const record = await withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId() }, (ctx) =>
      identity.listStaffAccess(ctx, { limit: 10 }),
    );
    expect(record.items.map((i) => i.id)).toEqual([session.id]);
  });

  it('[S1-09] guard: tenants never write sessions; staff start only their own, now, ≤ 60 minutes, and only end them', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await start(support.userId, f);
    // Tenants read the sessions they may see (S1-F10) but cannot write them.
    expect(
      await refusal(
        withTenant({ agencyId: f.agencyId, userId: f.userId }, (tx) =>
          tx.execute(sql`update staff_impersonations set ended_at = now() where id = ${session.id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await refusal(
        withTenant({ agencyId: f.agencyId, userId: f.userId }, (tx) =>
          tx.execute(sql`delete from staff_impersonations where id = ${session.id}`),
        ),
      ),
    ).toBe('42501');
    const raw = (fn: (tx: Parameters<Parameters<typeof withStaff>[1]>[0]) => Promise<unknown>) =>
      refusal(withStaff({ userId: support.userId, reason: 'guard test' }, fn));
    const insertSql = (staff: string, expires: string) => sql`insert into staff_impersonations
      (id, agency_id, staff_user_id, target_user_id, reason, expires_at)
      values (${newId()}, ${f.agencyId}, ${staff}, ${f.userId}, ${REASON}, now() + ${expires}::interval)`;
    // Longer than 60 minutes, or as another staff member: refused.
    await raw((tx) => tx.execute(sql`update staff_impersonations set ended_at = now() where id = ${session.id}`));
    expect(await raw((tx) => tx.execute(insertSql(support.userId, '2 hours')))).toBe('42501');
    const colleague = await createStaffUser('STAFF_SUPPORT');
    expect(await raw((tx) => tx.execute(insertSql(colleague.userId, '30 minutes')))).toBe('42501');
    // Data ops may not impersonate, even writing the row directly (guard 0028 mirrors `canStaff`).
    const ops = await createStaffUser('STAFF_DATA_OPS');
    expect(
      await refusal(
        withStaff({ userId: ops.userId, reason: 'guard test' }, (tx) =>
          tx.execute(insertSql(ops.userId, '30 minutes')),
        ),
      ),
    ).toBe('42501');
    // An ended session is never reopened or changed.
    expect(
      await raw((tx) => tx.execute(sql`update staff_impersonations set ended_at = null where id = ${session.id}`)),
    ).toBe('42501');
    expect(
      await raw((tx) =>
        tx.execute(sql`update staff_impersonations set reason = 'Something else entirely' where id = ${session.id}`),
      ),
    ).toBe('42501');
    // app_auth (the mint) only reads.
    expect(
      await refusal(
        withAuth((tx) => tx.execute(sql`update staff_impersonations set ended_at = now() where id = ${session.id}`)),
      ),
    ).toBe('42501');
    // The staff audit viewer can show the whole story.
    const log = await asStaff(support.userId, (ctx) =>
      compliance.listAuditLogForStaff(ctx, { agencyId: f.agencyId, limit: 100 }),
    );
    expect(log.items.map((i) => i.type)).toContain('staff.impersonation.started');
  });
});
