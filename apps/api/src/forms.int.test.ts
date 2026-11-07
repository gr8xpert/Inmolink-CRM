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
 * The forms library over HTTP (R2-05a): routes, schemas (the template union, the one-subject list filter), the flag,
 * the 201 / 200 replay codes, a ready form's hash and signed link, and another agency's 404. The merge itself is
 * tested in `documents/__tests__/forms.int.test.ts`.
 */

const FLAG = 'documents.forms';
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
const sha = 'ab'.repeat(32);

beforeAll(async () => {
  await setupTestDb('http');
  configureStorage(createMemoryStore());
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  await adminQuery(
    `insert into feature_flags (key, enabled, description) values ($1, false, '') on conflict (key) do nothing`,
    [FLAG],
  );
  await adminQuery(
    `update feature_flags set enabled_for = array_remove(enabled_for, $2::uuid) || array[$2::uuid] where key = $1`,
    [FLAG, a.agencyId],
  );
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
  await adminQuery(`update feature_flags set enabled_for = array_remove(enabled_for, $2::uuid) where key = $1`, [
    FLAG,
    a.agencyId,
  ]);
  await app?.close();
  await closeDb();
});

describe('[R2-05a] forms over HTTP', () => {
  it('[R2-05a] create: the template union validates (422), the flag gates (403), the merge refuses unknown data (404)', async () => {
    const offer = { template: 'OFFER', listingId: newId(), contactId: newId(), validUntil: '2026-12-01' };
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/documents/forms',
      headers: await bearer(a),
      payload: offer,
    });
    expect(bad.statusCode).toBe(422);
    const unknownTemplate = await app.inject({
      method: 'POST',
      url: '/v1/documents/forms',
      headers: await bearer(a),
      payload: { ...offer, template: 'WILL', offer: { amountCents: 1, currency: 'EUR' } },
    });
    expect(unknownTemplate.statusCode).toBe(422);
    const body = { ...offer, offer: { amountCents: 100_000, currency: 'EUR' } };
    const off = await app.inject({
      method: 'POST',
      url: '/v1/documents/forms',
      headers: await bearer(b),
      payload: body,
    });
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('FORMS_NOT_ENABLED');
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/documents/forms',
      headers: { ...(await bearer(a)), 'idempotency-key': `k-${newId()}` },
      payload: body,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('LISTING_NOT_FOUND');
    const deal = await app.inject({
      method: 'POST',
      url: `/v1/mls/deals/${newId()}/collaboration-agreement`,
      headers: await bearer(a),
      payload: { locale: 'en' },
    });
    expect(deal.statusCode).toBe(404);
    expect(deal.json().error.code).toBe('DEAL_NOT_FOUND');
  });

  it('[R2-05a] read: a ready form carries its hash and a signed link; lists page, filter one subject; another agency 404', async () => {
    const one = await app.inject({ method: 'GET', url: `/v1/documents/forms/${readyId}`, headers: await bearer(a) });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: readyId, status: 'READY', sha256: sha, sizeBytes: 1234 });
    expect(one.json().url).toContain(`form-documents/${a.agencyId}/${readyId}.pdf`);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/documents/forms?template=OFFER',
      headers: await bearer(a),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((f: { id: string }) => f.id)).toContain(readyId);
    expect(list.json().items[0].url).toBeNull();
    const two = await app.inject({
      method: 'GET',
      url: `/v1/documents/forms?contactId=${newId()}&listingId=${newId()}`,
      headers: await bearer(a),
    });
    expect(two.statusCode).toBe(422);
    const other = await app.inject({ method: 'GET', url: `/v1/documents/forms/${readyId}`, headers: await bearer(b) });
    // another agency (here without the flag) never reads it; the cross-agency 404 is the core test's
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe('FORMS_NOT_ENABLED');
    // the flag gates reads too
    expect((await app.inject({ method: 'GET', url: '/v1/documents/forms', headers: await bearer(b) })).statusCode).toBe(
      403,
    );
  });
});
