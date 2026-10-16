import { ListListingsQuery } from '@inmolink/contracts';
import { closeDb, pingDb } from '@inmolink/core';
import { createFounder } from '@inmolink/core/test';
import { setupTestDb } from '@inmolink/db/testing';
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
import { listingDocumentUploads } from './routes/media/routes';

/** Listing routes over HTTP (S3-02): auth, validation and error mapping; the rules are tested in core. */

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (sub: string, agency: string) => ({
  authorization: `Bearer ${(await signer.sign({ sub, aud: 'api', sv: 1, agency })).token}`,
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
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe('listing routes', () => {
  it('[S3-02] listing routes need a session, validate input and map service errors', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/listings' })).statusCode).toBe(401);
    const f = await createFounder();
    const headers = await bearer(f.userId, f.agencyId);

    const list = await app.inject({ method: 'GET', url: '/v1/listings', headers });
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json()).toEqual({ items: [], nextCursor: null });
    // Query booleans are strings: "false" means false (not JS truthiness).
    expect(ListListingsQuery.parse({ mine: 'false', deleted: 'false' })).toMatchObject({ mine: false, deleted: false });
    expect(ListListingsQuery.parse({ mine: 'true' }).mine).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/v1/listings?deleted=maybe', headers })).statusCode).toBe(422);

    const tooMuchSplit = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers,
      payload: { propertyTypeId: newId(), locationId: newId(), splitBp: 10_001 },
    });
    expect(tooMuchSplit.statusCode).toBe(422);

    const unknownLocation = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers,
      payload: { propertyTypeId: newId(), locationId: newId() },
    });
    expect(unknownLocation.statusCode).toBe(422);
    expect(unknownLocation.json().error.code).toBe('VALIDATION_FAILED');

    const missing = await app.inject({ method: 'GET', url: `/v1/listings/${newId()}`, headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('LISTING_NOT_FOUND');
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/listings/${newId()}`,
      headers,
      payload: { version: 1, bedrooms: 2 },
    });
    expect(stale.statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/listings/${newId()}`, headers })).statusCode).toBe(404);
  });

  it('[S3-08] quality and confirm routes need a session, validate input and map service errors', async () => {
    const id = newId();
    expect((await app.inject({ method: 'GET', url: `/v1/listings/${id}/quality` })).statusCode).toBe(401);
    const f = await createFounder();
    const headers = await bearer(f.userId, f.agencyId);
    const quality = await app.inject({ method: 'GET', url: `/v1/listings/${id}/quality`, headers });
    expect(quality.statusCode).toBe(404);
    expect(quality.json().error.code).toBe('LISTING_NOT_FOUND');
    expect((await app.inject({ method: 'GET', url: '/v1/listings/nope/quality', headers })).statusCode).toBe(422);
    const confirm = await app.inject({ method: 'POST', url: `/v1/listings/${id}/confirm`, headers });
    expect(confirm.statusCode).toBe(404);
    expect(confirm.json().error.code).toBe('LISTING_NOT_FOUND');
  });

  it('[S3-F10] a user over the buffered-upload cap gets 429 before the body is read; the slot frees after', async () => {
    const f = await createFounder();
    const headers = { ...(await bearer(f.userId, f.agencyId)), 'content-type': 'application/pdf' };
    const url = `/v1/listings/${newId()}/documents?fileName=a.pdf`;
    const payload = Buffer.from('%PDF-1.7\n%%EOF\n');
    const held = [listingDocumentUploads.take(f.userId), listingDocumentUploads.take(f.userId)];
    try {
      const over = await app.inject({ method: 'POST', url, headers, payload });
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('RATE_LIMITED');
    } finally {
      for (const release of held) release?.();
    }
    // Under the cap the request reaches the service (an unknown listing), and its slot is released with the reply.
    const ok = await app.inject({ method: 'POST', url, headers, payload });
    expect(ok.statusCode).not.toBe(429);
    expect(listingDocumentUploads.held(f.userId)).toBe(0);
    expect(listingDocumentUploads.total()).toBe(0);
  });
});
