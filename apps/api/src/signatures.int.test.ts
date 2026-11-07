import { createHash } from 'node:crypto';
import { closeDb, pingDb } from '@inmolink/core';
import { createFounder, type Founder } from '@inmolink/core/test';
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { invalidateFlags } from '@inmolink/platform/flags';
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
 * Signing requests over HTTP (R2-05b): routes and schemas, both flags, the 201 / 200 replay, the request read and
 * list, and the verification of a raw PDF against the stored hashes (another agency's request a 404). The flow itself
 * is tested in `documents/__tests__/signatures.int.test.ts`.
 */

const FLAGS = ['documents.forms', 'documents.esign'];
const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;
const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (f: Founder) => ({
  authorization: `Bearer ${(await signer.sign({ sub: f.userId, aud: 'api', sv: 1, agency: f.agencyId })).token}`,
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
let a: Founder;
let b: Founder;
const readyId = newId();
const original = new TextEncoder().encode('%PDF-1.7 signing over http');
const sha = createHash('sha256').update(original).digest('hex');

beforeAll(async () => {
  await setupTestDb('http');
  configureStorage(createMemoryStore());
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  for (const flag of FLAGS) {
    await adminQuery(
      `insert into feature_flags (key, enabled, description) values ($1, false, '') on conflict (key) do nothing`,
      [flag],
    );
    await adminQuery(
      `update feature_flags set enabled_for = array_remove(enabled_for, $2::uuid) || array[$2::uuid] where key = $1`,
      [flag, a.agencyId],
    );
  }
  invalidateFlags();
  await adminQuery(
    `insert into form_documents (id, agency_id, template, locale, template_version, status, label, data, sha256,
       size_bytes, rendered_at, created_by_user_id)
     values ($1, $2, 'OFFER', 'en', 1, 'READY', 'REF-1 · Ana', '{}', $3, 1234, now(), $4)`,
    [readyId, a.agencyId, sha, a.userId],
  );
  app = await build();
}, 120_000);

afterAll(async () => {
  await adminQuery(`delete from form_documents where agency_id = any($1::uuid[])`, [[a.agencyId, b.agencyId]]);
  for (const flag of FLAGS) {
    await adminQuery(`update feature_flags set enabled_for = array_remove(enabled_for, $2::uuid) where key = $1`, [
      flag,
      a.agencyId,
    ]);
  }
  await app?.close();
  await closeDb();
});

describe('[R2-05b] signing requests over HTTP', () => {
  it('[R2-05b] create: validated (422), flag-gated (403), 201 then a 200 replay; read and list', async () => {
    const url = `/v1/documents/forms/${readyId}/signature-requests`;
    const payload = { signers: [{ name: 'Ana Buyer', email: 'ana@example.com', role: 'buyer' }] };
    const invalid = await app.inject({
      method: 'POST',
      url,
      headers: await bearer(a),
      payload: { signers: [{ name: 'Ana', email: 'not-an-email', role: 'buyer' }] },
    });
    expect(invalid.statusCode).toBe(422);
    const off = await app.inject({ method: 'POST', url, headers: await bearer(b), payload });
    expect(off.statusCode).toBe(403);
    const key = { 'idempotency-key': `k-${newId()}` };
    const made = await app.inject({ method: 'POST', url, headers: { ...(await bearer(a)), ...key }, payload });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ formId: readyId, status: 'OPEN', documentSha256: sha, url: null });
    expect(made.json().signers[0]).toMatchObject({ name: 'Ana Buyer', email: 'ana@example.com', signedAt: null });
    const replay = await app.inject({ method: 'POST', url, headers: { ...(await bearer(a)), ...key }, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(made.json().id);
    const one = await app.inject({
      method: 'GET',
      url: `/v1/documents/signature-requests/${made.json().id}`,
      headers: await bearer(a),
    });
    expect(one.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url, headers: await bearer(a) });
    expect(list.json().items.map((r: { id: string }) => r.id)).toContain(made.json().id);
  });

  it('[R2-05b] verify: a raw PDF body against the stored hashes; another agency 404; JSON refused', async () => {
    const made = await app.inject({
      method: 'POST',
      url: `/v1/documents/forms/${readyId}/signature-requests`,
      headers: await bearer(a),
      payload: { signers: [{ name: 'Bo Buyer', email: 'bo@example.com', role: 'buyer' }] },
    });
    const id = made.json().id as string;
    const verify = async (f: Founder, body: Uint8Array | string, type = 'application/pdf') =>
      app.inject({
        method: 'POST',
        url: `/v1/documents/signature-requests/${id}/verify`,
        headers: { ...(await bearer(f)), 'content-type': type },
        payload: typeof body === 'string' ? body : Buffer.from(body),
      });
    const same = await verify(a, original);
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ requestId: id, match: 'ORIGINAL', sha256: sha, signedSha256: null });
    const other = await verify(a, new TextEncoder().encode('%PDF-other'));
    expect(other.json().match).toBe('NONE');
    expect((await verify(a, '{}', 'application/json')).statusCode).toBe(415);
    await adminQuery(
      `update feature_flags set enabled_for = array_remove(enabled_for, $2::uuid) || array[$2::uuid] where key = any($1)`,
      [FLAGS, b.agencyId],
    );
    invalidateFlags();
    try {
      const foreign = await verify(b, original);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().error.code).toBe('SIGNATURE_REQUEST_NOT_FOUND');
    } finally {
      await adminQuery(
        `update feature_flags set enabled_for = array_remove(enabled_for, $2::uuid) where key = any($1)`,
        [FLAGS, b.agencyId],
      );
      invalidateFlags();
    }
  });
});
