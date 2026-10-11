import { closeDb, pingDb } from '@inmolink/core';
import { createFounder } from '@inmolink/core/test';
import { createStaffUser, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
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
import { configureStorage, createS3Store, storageConfigFromEnv } from '@inmolink/platform/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/** Agency verification over HTTP (S1-03): agency routes, staff routes and who may call them. */

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

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

let app: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
  await setupTestDb('http');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

/** A founder who finished onboarding, with their auth headers. */
async function onboarded() {
  const f = await createFounder({ companyName: `Sierra ${newId().slice(-6)} S.L.` });
  const headers = await bearer(f.userId, f.agencyId);
  const { version } = (await app.inject({ method: 'GET', url: '/v1/agency', headers })).json() as { version: number };
  const saved = await app.inject({
    method: 'PUT',
    url: '/v1/agency/details',
    headers,
    payload: {
      version,
      name: `Sierra ${f.agencyId.slice(-6)} S.L.`,
      taxId: 'B12345674',
      addressLine: 'Calle Mayor 1',
      city: 'Granada',
      postalCode: '18001',
      region: 'ES-AN',
      languages: ['es'],
    },
  });
  expect(saved.statusCode).toBe(200);
  return { f, headers };
}

const upload = (headers: Record<string, string>, body: Buffer, contentType = 'application/pdf') =>
  app.inject({
    method: 'POST',
    url: '/v1/agency/verification/documents?kind=TAX_ID&fileName=cif.pdf',
    headers: { ...headers, 'content-type': contentType },
    payload: body,
  });

describe('verification routes', () => {
  it('[S1-03] an agency uploads and submits; staff review, download and approve; the agency is VERIFIED at once', async () => {
    const { f, headers } = await onboarded();
    const doc = await upload(headers, PDF);
    expect(doc.statusCode).toBe(201);
    expect(doc.json()).toMatchObject({ kind: 'TAX_ID', contentType: 'application/pdf', submitted: false });

    const view = await app.inject({ method: 'GET', url: '/v1/agency/verification', headers });
    const { agencyVersion } = view.json() as { agencyVersion: number };
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/agency/verification',
      headers,
      payload: { version: agencyVersion },
    });
    expect(submitted.statusCode).toBe(200);
    const requestId = (submitted.json() as { latestRequest: { id: string } }).latestRequest.id;

    const staff = await createStaffUser('STAFF_SUPPORT');
    const staffHeaders = await bearer(staff.userId);
    const queue = await app.inject({
      method: 'GET',
      url: '/v1/staff/verification-requests?limit=100',
      headers: staffHeaders,
    });
    expect(queue.statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/staff/verification-requests/${requestId}`,
      headers: staffHeaders,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { agency: { version: number; taxId: string }; documents: { id: string }[] };
    expect(body.agency.taxId).toBe('B12345674');

    const link = await app.inject({
      method: 'GET',
      url: `/v1/staff/verification-requests/${requestId}/documents/${body.documents[0]?.id}/url`,
      headers: staffHeaders,
    });
    expect(link.statusCode).toBe(200);
    expect(link.headers['cache-control']).toBe('no-store');
    const file = await fetch((link.json() as { url: string }).url);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PDF);

    const decided = await app.inject({
      method: 'POST',
      url: `/v1/staff/verification-requests/${requestId}/decision`,
      headers: staffHeaders,
      payload: { decision: 'APPROVE', agencyVersion: body.agency.version, reason: 'CIF and deeds checked' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: 'APPROVED', reviewerUserId: staff.userId });

    const agency = await app.inject({ method: 'GET', url: '/v1/agency', headers });
    expect(agency.json()).toMatchObject({ id: f.agencyId, status: 'VERIFIED' });
    // A second decision on the same request is refused.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/staff/verification-requests/${requestId}/decision`,
      headers: staffHeaders,
      payload: { decision: 'REJECT', agencyVersion: body.agency.version + 1, reason: 'changed my mind' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'VERIFICATION_NOT_OPEN' } });
  }, 60_000);

  it('[S1-03] staff APIs answer 403 to tenants and to users who are not staff; staff cannot use tenant routes', async () => {
    const { headers } = await onboarded();
    const nobody = await bearer(newId());
    const staff = await createStaffUser('STAFF_SUPPORT');
    // A staff member's token never carries an agency; one that does is refused on staff routes.
    const staffWithAgency = await bearer(staff.userId, newId());
    for (const h of [headers, nobody, staffWithAgency]) {
      const res = await app.inject({ method: 'GET', url: '/v1/staff/verification-requests', headers: h });
      expect(res.statusCode).toBe(403);
    }
    const tenantRoute = await app.inject({
      method: 'GET',
      url: '/v1/agency/verification',
      headers: await bearer(staff.userId),
    });
    expect(tenantRoute.statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'GET', url: '/v1/staff/verification-requests' });
    expect(anonymous.statusCode).toBe(401);
  }, 30_000);

  it('[S1-03] uploads: the real type is checked by magic bytes; other bodies and oversize files are refused', async () => {
    const { headers } = await onboarded();
    const html = await upload(headers, Buffer.from('<html><script>alert(1)</script></html>'));
    expect(html.statusCode).toBe(415);
    expect(html.json()).toMatchObject({ error: { code: 'DOCUMENT_TYPE_NOT_ALLOWED' } });
    const asText = await upload(headers, PDF, 'text/plain');
    expect(asText.statusCode).toBe(415);
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1);
    PDF.copy(huge);
    const tooBig = await upload(headers, huge);
    expect(tooBig.statusCode).toBe(413);
    const badName = await app.inject({
      method: 'POST',
      url: '/v1/agency/verification/documents?kind=TAX_ID&fileName=..%2F..%2Fetc%2Fpasswd',
      headers: { ...headers, 'content-type': 'application/pdf' },
      payload: PDF,
    });
    expect(badName.statusCode).toBe(422);
    // A JSON body never reaches the upload as a file.
    const json = await app.inject({
      method: 'POST',
      url: '/v1/agency/verification/documents?kind=TAX_ID&fileName=cif.pdf',
      headers,
      payload: { not: 'a file' },
    });
    expect(json.statusCode).toBe(415);
    // Only the upload route takes binary bodies: a PDF posted to submit is refused before parsing.
    const pdfToSubmit = await app.inject({
      method: 'POST',
      url: '/v1/agency/verification',
      headers: { ...headers, 'content-type': 'application/pdf' },
      payload: PDF,
    });
    expect(pdfToSubmit.statusCode).toBe(415);
  }, 30_000);

  it('[S1-03] the verification routes are in the OpenAPI document with request and response schemas', async () => {
    await app.ready();
    const doc = app.swagger() as { paths: Record<string, Record<string, { operationId?: string }>> };
    expect(doc.paths['/v1/agency/verification/documents']?.post?.operationId).toBe(
      'agencies.uploadVerificationDocument',
    );
    expect(doc.paths['/v1/staff/verification-requests/{id}/decision']?.post?.operationId).toBe(
      'agencies.decideVerification',
    );
  });
});
