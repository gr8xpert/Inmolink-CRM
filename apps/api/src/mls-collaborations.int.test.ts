import { closeDb, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as mls from '@inmolink/core/modules/mls';
import { createFounder, type Founder } from '@inmolink/core/test';
import { countQueries } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
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

beforeAll(async () => {
  await setupTestDb('http');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    keyring: createKeyring({ keys: { t1: generateKey() }, activeKeyId: 't1' }),
  });
  mls.configureMls({ keyring, fingerprintKey: 'test-fingerprint-key-s11-06-0123456789abcdef' });
  app = await build();
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  await adminQuery(`begin; set local session_replication_role = replica;
    ${registrations(a.agencyId, b.agencyId)}
    ${registrations(b.agencyId, a.agencyId)}
    ${viewings(a.agencyId, b.agencyId)}
    ${viewings(b.agencyId, a.agencyId)}
    commit;`);
}, 120_000);

afterAll(async () => {
  for (const m of [a, b]) {
    await adminQuery(`begin; set local session_replication_role = replica;
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
    expect(total).toBeLessThanOrEqual(10);
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
});
