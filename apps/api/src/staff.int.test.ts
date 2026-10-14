import { authCtx, closeDb, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { adminQuery, createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/** Staff console APIs and impersonation over HTTP (S1-09). */

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (sub: string, agency?: string) => ({
  authorization: `Bearer ${(await signer.sign({ sub, aud: 'api', sv: 1, ...(agency ? { agency } : {}) })).token}`,
});

const build = () =>
  buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allowAll,
    readinessCacheMs: 0,
    checks: { db: () => pingDb('app_user') },
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(`t1:${pair.publicKey}`) }),
  });

let app: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
  await setupTestDb('http');
  // The web's mint, with the key the API trusts: impersonation tokens come from `issueAccessToken`.
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    webUrl: 'http://web.test',
    signer,
    keyring: createKeyring({ keys: { t1: generateKey() }, activeKeyId: 't1' }),
  });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

const REASON = 'Ticket 4711: the agency cannot see its invites';

/** Mints the impersonation token the web would, for a staff session that passed 2FA. */
const impersonationHeaders = async (staffUserId: string, impersonationId: string) => {
  const { token } = await identity.issueAccessToken(authCtx(newId()), {
    userId: staffUserId,
    sessionVersion: 1,
    audience: 'api',
    mfaVerified: true,
    impersonationId,
  });
  return { authorization: `Bearer ${token}` };
};

const STAFF_ROUTES = (agencyId: string, impersonationId: string) => [
  { method: 'GET' as const, url: '/v1/staff/me' },
  { method: 'GET' as const, url: '/v1/staff/agencies' },
  { method: 'GET' as const, url: `/v1/staff/agencies/${agencyId}` },
  { method: 'GET' as const, url: `/v1/staff/agencies/${agencyId}/members` },
  { method: 'GET' as const, url: '/v1/staff/audit-logs' },
  { method: 'GET' as const, url: '/v1/staff/impersonations' },
  { method: 'GET' as const, url: '/v1/staff/verification-requests' },
  {
    method: 'POST' as const,
    url: '/v1/staff/impersonations',
    payload: { agencyId, userId: newId(), reason: REASON },
  },
  { method: 'POST' as const, url: `/v1/staff/impersonations/${impersonationId}/end` },
];

describe('staff console API', () => {
  it('[S1-09] non-staff get 403 on every staff API: tenants, users without a staff role, impersonation tokens', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const started = await app.inject({
      method: 'POST',
      url: '/v1/staff/impersonations',
      headers: await bearer(support.userId),
      payload: { agencyId: f.agencyId, userId: f.userId, reason: REASON },
    });
    expect(started.statusCode).toBe(201);
    const session = started.json();

    const tenant = await bearer(f.userId, f.agencyId);
    const nobody = await bearer(newId());
    const impersonating = await impersonationHeaders(support.userId, session.id);
    for (const route of STAFF_ROUTES(f.agencyId, session.id)) {
      for (const headers of [tenant, nobody, impersonating]) {
        const res = await app.inject({ ...route, headers });
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
      }
    }
    // Staff reach them (the session is still open: nothing above ended it).
    const me = await app.inject({ method: 'GET', url: '/v1/staff/me', headers: await bearer(support.userId) });
    expect(me.json()).toMatchObject({ role: 'STAFF_SUPPORT', impersonation: { id: session.id, userId: f.userId } });
  });

  it('[S1-09] tenants list, detail and members for staff; reads of a tenant and its members are audited', async () => {
    const f = await createFounder({ companyName: `Staff Lookup ${newId().slice(-6)} S.L.` });
    const support = await createStaffUser('STAFF_SUPPORT');
    const headers = await bearer(support.userId);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/staff/agencies?status=PENDING&q=${encodeURIComponent('staff lookup')}&limit=100`,
      headers,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.map((t: { id: string }) => t.id)).toContain(f.agencyId);
    const detail = await app.inject({ method: 'GET', url: `/v1/staff/agencies/${f.agencyId}`, headers });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ id: f.agencyId, status: 'PENDING', verification: null, onboarded: false });
    const members = await app.inject({ method: 'GET', url: `/v1/staff/agencies/${f.agencyId}/members`, headers });
    expect(members.statusCode, members.body).toBe(200);
    expect(members.json().items).toEqual([expect.objectContaining({ userId: f.userId, role: 'AGENCY_ADMIN' })]);
    const reads = await adminQuery<{ type: string; actor_user_id: string }>(
      `select type, actor_user_id from audit_logs where agency_id = $1 and type like 'staff.%' order by occurred_at, id`,
      [f.agencyId],
    );
    expect(reads).toEqual([
      { type: 'staff.tenant.read', actor_user_id: support.userId },
      { type: 'staff.members.read', actor_user_id: support.userId },
    ]);

    // Data ops read the tenants list and details; not members' names and emails, impersonation or audit logs.
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const opsList = await app.inject({ method: 'GET', url: '/v1/staff/agencies?limit=1', headers: ops });
    expect(opsList.statusCode, opsList.body).toBe(200);
    for (const route of [
      { method: 'GET' as const, url: `/v1/staff/agencies/${f.agencyId}/members` },
      { method: 'GET' as const, url: '/v1/staff/audit-logs' },
      {
        method: 'POST' as const,
        url: '/v1/staff/impersonations',
        payload: { agencyId: f.agencyId, userId: f.userId, reason: REASON },
      },
    ]) {
      const res = await app.inject({ ...route, headers: ops });
      expect(res.statusCode, `${route.url} ${res.body}`).toBe(403);
    }
  });

  it('[S1-09] concurrent starts by one staff member do not fail (no 500): one session stays open', async () => {
    const f = await createFounder();
    const g = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const headers = await bearer(support.userId);
    const res = await Promise.all(
      [f, g].map((t) =>
        app.inject({
          method: 'POST',
          url: '/v1/staff/impersonations',
          headers,
          payload: { agencyId: t.agencyId, userId: t.userId, reason: REASON },
        }),
      ),
    );
    expect(res.map((r) => r.statusCode)).toEqual([201, 201]);
    const open = await adminQuery<{ n: number }>(
      `select count(*)::int as n from staff_impersonations where staff_user_id = $1 and ended_at is null`,
      [support.userId],
    );
    expect(open).toEqual([{ n: 1 }]);
  });

  it('[S1-09] every action during impersonation records both the staff member and the impersonated user; ending applies on the next request', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const staffHeaders = await bearer(support.userId);
    const started = await app.inject({
      method: 'POST',
      url: '/v1/staff/impersonations',
      headers: staffHeaders,
      payload: { agencyId: f.agencyId, userId: f.userId, reason: REASON, minutes: 15 },
    });
    expect(started.statusCode).toBe(201);
    const session = started.json();
    const headers = await impersonationHeaders(support.userId, session.id);

    // The token acts as the founder in their agency.
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers });
    expect(me.json()).toMatchObject({ userId: f.userId, agencyId: f.agencyId });

    // Team changes are refused: an invite to the staff member's own email would outlive the session.
    const invited = await app.inject({
      method: 'POST',
      url: '/v1/invites',
      headers,
      payload: { email: support.email, role: 'AGENCY_ADMIN' },
    });
    expect(invited.statusCode, invited.body).toBe(403);

    // What staff may change — the profile — is audited and evented with both people.
    const profile = await app.inject({
      method: 'PUT',
      url: '/v1/agency/profile',
      headers,
      payload: {
        version: 0,
        primaryColor: '#0A7CFF',
        accentColor: null,
        contactEmail: 'support@costa.example',
        contactPhone: null,
        websiteUrl: null,
        translations: [],
      },
    });
    expect(profile.statusCode, profile.body).toBe(200);
    const [auditRow] = await adminQuery<{ actor_kind: string; actor_user_id: string; impersonated_by: string }>(
      `select actor_kind, actor_user_id, impersonated_by from audit_logs
        where agency_id = $1 and type = 'agencies.profile.updated'`,
      [f.agencyId],
    );
    expect(auditRow).toEqual({ actor_kind: 'user', actor_user_id: f.userId, impersonated_by: support.userId });
    const [event] = await adminQuery<{ payload: Record<string, unknown> }>(
      `select payload from outbox_events where agency_id = $1 and type = 'agencies.profile.updated'`,
      [f.agencyId],
    );
    expect(event?.payload).toMatchObject({ actorUserId: f.userId, impersonatedBy: support.userId });

    // The start and the staff member's read of the agency's log are audited as staff.
    const log = await app.inject({
      method: 'GET',
      url: `/v1/staff/audit-logs?agencyId=${f.agencyId}&limit=100`,
      headers: staffHeaders,
    });
    expect(log.statusCode).toBe(200);
    const types = log.json().items.map((i: { type: string }) => i.type);
    expect(types).toEqual(expect.arrayContaining(['agencies.profile.updated', 'staff.impersonation.started']));
    expect(log.json().items.find((i: { type: string }) => i.type === 'agencies.profile.updated').actor).toMatchObject({
      kind: 'user',
      userId: f.userId,
      impersonatedBy: support.userId,
    });
    const reads = await adminQuery<{ actor_user_id: string }>(
      `select actor_user_id from audit_logs where agency_id = $1 and type = 'staff.auditLog.read'`,
      [f.agencyId],
    );
    expect(reads).toEqual([{ actor_user_id: support.userId }]);

    // Ending: the very next request with the same (unexpired) token is refused, and no new token is minted.
    const ended = await app.inject({
      method: 'POST',
      url: `/v1/staff/impersonations/${session.id}/end`,
      headers: staffHeaders,
    });
    expect(ended.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/v1/agency', headers });
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('IMPERSONATION_ENDED');
    await expect(impersonationHeaders(support.userId, session.id)).rejects.toMatchObject({
      code: 'IMPERSONATION_ENDED',
    });
  });

  it('[S1-F9] admins read the staff access record over HTTP; disabling the staff login ends the session on the next request', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const started = await app.inject({
      method: 'POST',
      url: '/v1/staff/impersonations',
      headers: await bearer(support.userId),
      payload: { agencyId: f.agencyId, userId: f.userId, reason: REASON },
    });
    expect(started.statusCode).toBe(201);
    const session = started.json();

    // The agency's admin sees when and why — and never which staff member.
    const record = await app.inject({
      method: 'GET',
      url: '/v1/staff-access',
      headers: await bearer(f.userId, f.agencyId),
    });
    expect(record.statusCode, record.body).toBe(200);
    expect(record.json().items).toEqual([
      expect.objectContaining({ id: session.id, memberUserId: f.userId, reason: REASON, status: 'ACTIVE' }),
    ]);
    expect(record.body).not.toContain(support.userId);
    expect((await app.inject({ method: 'GET', url: '/v1/staff-access' })).statusCode).toBe(401);

    // The impersonated token works until the staff login is disabled; then the next request is refused.
    const headers = await impersonationHeaders(support.userId, session.id);
    expect((await app.inject({ method: 'GET', url: '/v1/agency', headers })).statusCode).toBe(200);
    // Not even the staff member can read the record while acting as the admin.
    expect((await app.inject({ method: 'GET', url: '/v1/staff-access', headers })).statusCode).toBe(403);
    await adminQuery(`update users set status = 'DISABLED' where id = $1`, [support.userId]);
    const after = await app.inject({ method: 'GET', url: '/v1/agency', headers });
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('IMPERSONATION_ENDED');
  });
});
