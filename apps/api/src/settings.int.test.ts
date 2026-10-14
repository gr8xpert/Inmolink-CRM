import { closeDb, pingDb } from '@inmolink/core';
import { createFounder } from '@inmolink/core/test';
import { setupTestDb } from '@inmolink/db/testing';
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

/** Agency profile and settings over HTTP (S1-06). */

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
  configureStorage(createMemoryStore());
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('agency settings routes', () => {
  it('[S1-06] admins read and save settings; invalid input is refused before the service', async () => {
    const f = await createFounder();
    const headers = await bearer(f.userId, f.agencyId);
    const got = await app.inject({ method: 'GET', url: '/v1/agency/settings', headers });
    expect(got.statusCode).toBe(200);
    expect(got.headers['cache-control']).toBe('no-store');
    const current = got.json();
    expect(current).toMatchObject({
      defaultCommission: { type: 'PCT', basisPoints: 500, includesVat: false },
      defaultSplitBp: 5000,
      registrationValidityDays: 180,
      version: 1,
    });

    const body = {
      version: current.version,
      defaultCommission: { type: 'PCT', basisPoints: 250, includesVat: true },
      defaultSplitBp: 4000,
      registrationValidityDays: 365,
      viewingResponseDays: 2,
      enabledLocales: current.enabledLocales,
      whiteLabel: { referencePrefix: 'ch', showPoweredBy: true, emailSenderName: null },
      clientMode: { pinMinLength: 4, pinMaxAttempts: 5 },
    };
    const saved = await app.inject({ method: 'PUT', url: '/v1/agency/settings', headers, payload: body });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.json()).toMatchObject({
      version: 2,
      whiteLabel: { referencePrefix: 'CH' },
      registrationValidityDays: 365,
      defaultSplitBp: 4000,
    });

    const splitTooHigh = await app.inject({
      method: 'PUT',
      url: '/v1/agency/settings',
      headers,
      payload: { ...body, version: 2, defaultSplitBp: 10_001 },
    });
    expect(splitTooHigh.statusCode).toBe(422);

    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/agency/settings',
      headers,
      payload: { ...body, version: 2, defaultCommission: { type: 'PCT', basisPoints: 20_000, includesVat: false } },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('[S1-06] profile save and logo upload (raw image body; other types refused)', async () => {
    const f = await createFounder();
    const headers = await bearer(f.userId, f.agencyId);
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/agency/profile',
      headers,
      payload: {
        version: 0,
        primaryColor: '#0A7CFF',
        accentColor: null,
        contactEmail: 'Hola@Costa.example',
        contactPhone: null,
        websiteUrl: 'javascript:alert(1)',
        translations: [],
      },
    });
    expect(saved.statusCode).toBe(422); // websiteUrl must be http(s)

    const ok = await app.inject({
      method: 'PUT',
      url: '/v1/agency/profile',
      headers,
      payload: {
        version: 0,
        primaryColor: '#0A7CFF',
        accentColor: null,
        contactEmail: 'Hola@Costa.example',
        contactPhone: null,
        websiteUrl: 'https://costa.example',
        translations: [{ locale: 'es', tagline: 'Casas', description: null }],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ version: 1, primaryColor: '#0a7cff', contactEmail: 'hola@costa.example' });

    const logo = await app.inject({
      method: 'PUT',
      url: '/v1/agency/profile/logo',
      headers: { ...headers, 'content-type': 'image/png' },
      payload: PNG,
    });
    expect(logo.statusCode).toBe(200);
    expect(logo.json().logo).toMatchObject({ contentType: 'image/png', sizeBytes: PNG.byteLength });

    const pdf = await app.inject({
      method: 'PUT',
      url: '/v1/agency/profile/logo',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('%PDF-1.7\n'),
    });
    expect(pdf.statusCode).toBe(415);

    const url = await app.inject({ method: 'GET', url: '/v1/agency/profile/logo/url', headers });
    expect(url.statusCode).toBe(200);
    expect(url.headers['cache-control']).toBe('no-store');

    const removed = await app.inject({ method: 'DELETE', url: '/v1/agency/profile/logo', headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().logo).toBeNull();
  });
});
