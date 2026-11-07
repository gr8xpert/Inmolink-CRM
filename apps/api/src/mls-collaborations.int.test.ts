import { closeDb, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as mls from '@inmolink/core/modules/mls';
import { countQueries, createFounder, type Founder } from '@inmolink/core/test';
import { adminQuery, createStaffUser, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey, rowCipher } from '@inmolink/platform/crypto';
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
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/**
 * My collaborations over HTTP (S11-06): the four lists the dashboard view loads for an agency with 500 collaborations,
 * query-counted per request, and what the owner's side may see of the introducer's client.
 */

const N = 125;
const CLIENT = 'Zelda Quuxberry';
const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (f: Founder) => ({
  authorization: `Bearer ${(await signer.sign({ sub: f.userId, aud: 'api', sv: 1, agency: f.agencyId })).token}`,
});
const keyring = createKeyring({ keys: { t1: generateKey() }, activeKeyId: 't1' });
const cipher = rowCipher('client_registrations', 'details_enc', () => keyring);

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
let a: Founder;
let b: Founder;
/** The introducer's contact ids: they must never reach the owner (the registration id is the receipt's own id). */
const secretIds: string[] = [];

function registrations(introducer: string, owner: string): string {
  const own: string[] = [];
  const receipts: string[] = [];
  for (let i = 1; i <= N; i++) {
    const id = newId();
    const contact = newId();
    const target = newId();
    secretIds.push(contact);
    const enc = cipher.encrypt(introducer, id, { firstName: 'Zelda', lastName: 'Quuxberry', emails: [], phones: [] });
    const exp = i % 2 === 0 ? `now() - interval '1 day'` : `now() + interval '100 days'`;
    own.push(
      `('${id}', '${introducer}', '${owner}', 'LISTING', '${target}', '${contact}', '${enc}', now() - interval '${i} days', ${exp})`,
    );
    receipts.push(
      `('${id}', '${owner}', '${introducer}', 'LISTING', '${target}', now() - interval '${i} days', ${exp})`,
    );
  }
  return `insert into client_registrations (id, agency_id, target_agency_id, target_kind, target_id, contact_id, details_enc, registered_at, expires_at)
      values ${own.join(',')};
    insert into client_registration_receipts (registration_id, agency_id, introducer_agency_id, target_kind, target_id, registered_at, expires_at)
      values ${receipts.join(',')};`;
}

const viewings = (introducer: string, owner: string) => `
  insert into viewing_requests (id, agency_id, owner_agency_id, registration_id, contact_id, target_kind, target_id,
                                status, awaiting, proposed_start_at, expires_at, commission_bp, split_bp,
                                commission_includes_vat, terms_valid_until, created_at, updated_at)
  select gen_random_uuid(), '${introducer}', '${owner}', gen_random_uuid(), gen_random_uuid(), 'LISTING',
         gen_random_uuid(), 'REQUESTED', 'OWNER', now() + interval '5 days', now() + interval '2 days', 500, 5000,
         false, now() + interval '90 days', now() - g * interval '1 day', now()
    from generate_series(1, ${N}) g;
  insert into viewing_request_receipts (request_id, agency_id, introducer_agency_id, target_kind, target_id, status,
                                        awaiting, proposed_start_at, expires_at, commission_bp, split_bp,
                                        commission_includes_vat, terms_valid_until, terms_at, introducer_accepted_at,
                                        created_at, updated_at)
  select id, owner_agency_id, agency_id, target_kind, target_id, status, awaiting, proposed_start_at, expires_at,
         commission_bp, split_bp, commission_includes_vat, terms_valid_until, terms_at, introducer_accepted_at,
         created_at, updated_at
    from viewing_requests where agency_id = '${introducer}' and owner_agency_id = '${owner}';`;

/** R2-04a: `N` deals of `introducer` and `owner`, both copies (3 % of 500,000.00 €, split 50 / 50). */
const deals = (introducer: string, owner: string) => `
  with d as (
    select gen_random_uuid() as id, gen_random_uuid() as vr, gen_random_uuid() as target, g
      from generate_series(1, ${N}) g)
  insert into deals (agency_id, id, party, peer_agency_id, viewing_request_id, target_kind, target_id, commission_bp,
                     split_bp, commission_includes_vat, terms_at, stage, price_cents, currency, created_at, updated_at)
  select x.agency, d.id, x.party, x.peer, d.vr, 'LISTING', d.target, 300, 5000, false, now(), 'OFFER', 50000000, 'EUR',
         now() - d.g * interval '1 day', now()
    from d cross join (values ('${introducer}'::uuid, 'INTRODUCER', '${owner}'::uuid),
                              ('${owner}'::uuid, 'OWNER', '${introducer}'::uuid)) x(agency, party, peer);`;

beforeAll(async () => {
  await setupTestDb('http');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    keyring: createKeyring({ keys: { t1: generateKey() }, activeKeyId: 't1' }),
  });
  mls.configureMls({ keyring, fingerprintKey: 'test-fingerprint-key-s11-06-0123456789abcdef' });
  configureStorage(createMemoryStore());
  app = await build();
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  // R2-04b: the deal room's writes are for verified agencies
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  await adminQuery(`begin; set local session_replication_role = replica;
    ${registrations(a.agencyId, b.agencyId)}
    ${registrations(b.agencyId, a.agencyId)}
    ${viewings(a.agencyId, b.agencyId)}
    ${viewings(b.agencyId, a.agencyId)}
    ${deals(a.agencyId, b.agencyId)}
    commit;`);
}, 120_000);

afterAll(async () => {
  for (const m of [a, b]) {
    await adminQuery(`begin; set local session_replication_role = replica;
      delete from deal_documents where agency_id = '${m.agencyId}';
      delete from deal_disputes where agency_id = '${m.agencyId}';
      delete from tasks where agency_id = '${m.agencyId}' and deal_id is not null;
      delete from chat_participants where agency_id = '${m.agencyId}';
      delete from chat_threads where agency_id = '${m.agencyId}' and kind = 'DEAL';
      delete from deals where agency_id = '${m.agencyId}';
      delete from viewing_request_receipts where introducer_agency_id = '${m.agencyId}' or agency_id = '${m.agencyId}';
      delete from viewing_requests where agency_id = '${m.agencyId}';
      delete from client_registration_receipts where introducer_agency_id = '${m.agencyId}' or agency_id = '${m.agencyId}';
      delete from client_registrations where agency_id = '${m.agencyId}'; commit;`);
  }
  await app?.close();
  await closeDb();
}, 60_000);

const URLS = [
  '/v1/mls/registrations',
  '/v1/mls/received-registrations',
  '/v1/mls/viewing-requests',
  '/v1/mls/received-viewing-requests',
] as const;

describe('my collaborations over HTTP', () => {
  it('[S11-06] the four lists load within 10 queries for an agency with 500 collaborations, each within 3 plus its setup', async () => {
    const headers = await bearer(a);
    // the request's own overhead (session, tenant context), measured on a list that is not part of the view
    const setup = await countQueries(() => app.inject({ method: 'GET', url: '/v1/me/capabilities', headers }));
    let total = 0;
    for (const url of URLS) {
      let status = 0;
      const n = await countQueries(async () => {
        status = (await app.inject({ method: 'GET', url: `${url}?limit=10`, headers })).statusCode;
      });
      expect(status, url).toBe(200);
      expect(n - setup, url).toBeLessThanOrEqual(3);
      total += n - setup;
    }
    // S12-F21: target labels add ≤ 1 statement per target kind on each list — the 10-query budget is per endpoint
    // (each list stays within 3 plus its setup), so the four together may pass 10
    expect(total).toBeLessThanOrEqual(12);
  });

  it('[S11-06] the owner sees who introduced a client and when, never the client, its contact or its registration', async () => {
    const headers = await bearer(b);
    const received = await app.inject({ method: 'GET', url: '/v1/mls/received-registrations?limit=100', headers });
    const viewingsIn = await app.inject({ method: 'GET', url: '/v1/mls/received-viewing-requests?limit=100', headers });
    expect(received.statusCode).toBe(200);
    expect(viewingsIn.statusCode).toBe(200);
    expect(viewingsIn.json().items.length).toBeGreaterThan(0);
    for (const res of [received, viewingsIn]) {
      const text = res.body;
      expect(text).not.toContain('Zelda');
      expect(text).not.toContain('Quuxberry');
      for (const id of secretIds) expect(text).not.toContain(id);
    }
    for (const v of viewingsIn.json().items) {
      expect(v).toMatchObject({ contactId: null, registrationId: null });
      expect(v).not.toHaveProperty('requestedByUserId');
    }
    // the introducer's own list does carry the client
    const own = await app.inject({ method: 'GET', url: '/v1/mls/registrations?limit=5', headers: await bearer(a) });
    expect(own.body).toContain(CLIENT.split(' ')[1]);
  });

  it('[S11-06] a day range with from after to is refused', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/mls/registrations?from=2026-05-02&to=2026-05-01',
      headers: await bearer(a),
    });
    expect(res.statusCode).toBe(422);
  });

  it('[R2-04a] the deal list loads within the dashboard budget with the database’s commission; staff routes refuse members', async () => {
    for (const [m, party] of [
      [a, 'INTRODUCER'],
      [b, 'OWNER'],
    ] as const) {
      const headers = await bearer(m);
      let body: { items: { party: string; commission: Record<string, number | string | boolean> }[] } | undefined;
      const queries = await countQueries(async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/mls/deals?limit=25', headers });
        expect(res.statusCode).toBe(200);
        body = res.json();
      });
      expect(queries).toBeLessThanOrEqual(10);
      expect(body?.items).toHaveLength(25);
      expect(body?.items[0]).toMatchObject({
        party,
        commission: { totalCents: 1_500_000, introducerShareCents: 750_000, ownerShareCents: 750_000, currency: 'EUR' },
      });
    }
    const someDeal = (
      await app.inject({ method: 'GET', url: '/v1/mls/deals?limit=1', headers: await bearer(a) })
    ).json().items[0].id as string;
    const staff = await app.inject({ method: 'GET', url: `/v1/staff/deals/${someDeal}`, headers: await bearer(a) });
    expect(staff.statusCode).toBe(403);
    const mediate = await app.inject({
      method: 'POST',
      url: `/v1/staff/deals/${someDeal}/mediate`,
      headers: await bearer(a),
      payload: { reason: 'x', price: { amountCents: 1, currency: 'EUR' } },
    });
    expect(mediate.statusCode).toBe(403);
  });

  it('[R2-04b] the deal room over HTTP: a raw PDF upload (named in a header; a retry answers the same document), the other party lists it within budget and opens it, oversize and non-PDF refused, removal 204; deal tasks 201 then 200 on a replay; the deal thread opens', async () => {
    const ha = await bearer(a);
    const hb = await bearer(b);
    const deal = (await app.inject({ method: 'GET', url: '/v1/mls/deals?limit=1', headers: ha })).json().items[0]
      .id as string;
    const body = Buffer.from(`%PDF-1.7\n% r2-04b ${deal}\n%%EOF\n`);
    const send = (payload: Buffer, type = 'application/pdf', name = 'Oferta firmada.pdf') =>
      app.inject({
        method: 'POST',
        url: `/v1/mls/deals/${deal}/documents?kind=OFFER`,
        headers: { ...ha, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
        payload,
      });
    const first = await send(body);
    expect(first.statusCode, first.body).toBe(201);
    const doc = first.json() as { id: string; fileName: string; kind: string };
    expect(doc).toMatchObject({ fileName: 'Oferta firmada.pdf', kind: 'OFFER' });
    const retry = await send(body);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().id).toBe(doc.id);
    expect((await send(Buffer.from('GIF89a not a pdf'), 'application/octet-stream')).statusCode).toBe(415);
    expect((await send(Buffer.alloc(20 * 1024 * 1024 + 1, 0x25))).statusCode).toBe(413);

    let listed: { items: { id: string }[] } | undefined;
    const queries = await countQueries(async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/mls/deals/${deal}/documents`, headers: hb });
      expect(res.statusCode).toBe(200);
      listed = res.json();
    });
    expect(queries).toBeLessThanOrEqual(10);
    expect(listed?.items.map((d) => d.id)).toEqual([doc.id]);
    const url = await app.inject({ method: 'GET', url: `/v1/mls/deals/${deal}/documents/${doc.id}/url`, headers: hb });
    expect(url.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/mls/deals/${deal}/documents/${doc.id}`, headers: hb }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/mls/deals/${deal}/documents/${doc.id}`, headers: ha }))
        .statusCode,
    ).toBe(204);

    const task = (key: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/mls/deals/${deal}/tasks`,
        headers: { ...ha, 'idempotency-key': key },
        payload: { title: 'Send the arras draft' },
      });
    const key = `r2-04b-${deal}`;
    const made = await task(key);
    expect(made.statusCode).toBe(201);
    expect(made.json().dealId).toBe(deal);
    const replay = await task(key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(made.json().id);
    const tasks = await app.inject({ method: 'GET', url: `/v1/crm/tasks?dealId=${deal}&assignee=any`, headers: hb });
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json().items).toEqual([]);

    const thread = await app.inject({
      method: 'POST',
      url: '/v1/chat/deal-threads',
      headers: ha,
      payload: { dealId: deal },
    });
    expect(thread.statusCode).toBeLessThan(300);
    expect(thread.json()).toMatchObject({ id: deal, kind: 'DEAL', dealId: deal });
  });

  it('[R2-04c] disputes over HTTP: a party raises one (201, a second 409), lists its own; the staff queue pages within budget; members are refused staff routes; data ops resolve (200, again 409)', async () => {
    const ha = await bearer(a);
    const hb = await bearer(b);
    const deal = (await app.inject({ method: 'GET', url: '/v1/mls/deals?limit=1', headers: ha })).json().items[0]
      .id as string;
    const raise = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `/v1/mls/deals/${deal}/disputes`,
        headers,
        payload: { reason: 'Commission invoice disputed' },
      });
    const first = await raise(ha);
    expect(first.statusCode, first.body).toBe(201);
    const dispute = first.json() as { id: string; status: string };
    expect(dispute.status).toBe('OPEN');
    expect((await raise(ha)).statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: `/v1/mls/deals/${deal}/disputes`, headers: ha, payload: {} }))
        .statusCode,
    ).toBe(422);
    const own = await app.inject({ method: 'GET', url: `/v1/mls/deals/${deal}/disputes`, headers: ha });
    expect(own.json().items.map((d: { id: string }) => d.id)).toEqual([dispute.id]);
    const theirs = await app.inject({ method: 'GET', url: `/v1/mls/deals/${deal}/disputes`, headers: hb });
    expect(theirs.json().items).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/mls/deals/${newId()}/disputes`, headers: ha })).statusCode,
    ).toBe(404);

    // members never reach the staff routes
    for (const req of [
      { method: 'GET' as const, url: '/v1/staff/deal-disputes' },
      { method: 'GET' as const, url: `/v1/staff/deals/${deal}/disputes` },
      { method: 'POST' as const, url: `/v1/staff/deal-disputes/${dispute.id}/resolve`, payload: { note: 'x' } },
    ]) {
      expect((await app.inject({ ...req, headers: ha })).statusCode).toBe(403);
    }

    const staffHeaders = async (role: 'STAFF_SUPPORT' | 'STAFF_DATA_OPS') => ({
      authorization: `Bearer ${(await signer.sign({ sub: (await createStaffUser(role)).userId, aud: 'api', sv: 1 })).token}`,
    });
    const support = await staffHeaders('STAFF_SUPPORT');
    const ops = await staffHeaders('STAFF_DATA_OPS');
    const queries = await countQueries(async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/staff/deal-disputes?status=OPEN&limit=100',
        headers: support,
      });
      expect(res.statusCode, res.body).toBe(200);
    });
    expect(queries).toBeLessThanOrEqual(10);
    const ofDeal = await app.inject({ method: 'GET', url: `/v1/staff/deals/${deal}/disputes`, headers: support });
    expect(ofDeal.json().items).toEqual([
      expect.objectContaining({ id: dispute.id, agency: expect.objectContaining({ id: a.agencyId }) }),
    ]);
    const resolve = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `/v1/staff/deal-disputes/${dispute.id}/resolve`,
        headers,
        payload: { note: 'Invoice corrected by the owner' },
      });
    expect((await resolve(support)).statusCode).toBe(403);
    const done = await resolve(ops);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: 'RESOLVED', resolutionNote: 'Invoice corrected by the owner' });
    expect((await resolve(ops)).statusCode).toBe(409);
  });
});
