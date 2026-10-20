import { closeDb, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
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

/** Website sites over HTTP (S7-01): members list sites, admins create and change them; keys are bound to one. */

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
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

const SITE = {
  name: 'Costa Homes',
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'OWN_ONLY',
  referencePrefix: 'CH',
  locales: ['en', 'es'],
  contact: { email: 'sales@costa-homes.example' },
};

describe('website site routes', () => {
  it('[S7-01] admins create, list and change sites; a change needs the current version', async () => {
    const f = await createFounder();
    const headers = await bearer(f.userId, f.agencyId);

    const created = await app.inject({ method: 'POST', url: '/v1/sites', headers, payload: SITE });
    expect(created.statusCode).toBe(201);
    const site = created.json() as { id: string; version: number };
    expect(site).toMatchObject({ inventoryPolicy: 'OWN_ONLY', defaultLocale: 'en', version: 1 });

    const list = await app.inject({ method: 'GET', url: '/v1/sites', headers });
    expect(list.json().items).toEqual([expect.objectContaining({ id: site.id, referencePrefix: 'CH' })]);

    const patch = {
      version: 1,
      inventoryPolicy: 'CUSTOM',
      // Own listings only: network inventory needs a verified agency (S7-F4), tested in core.
      inventoryFilters: { includeOwn: true, includeNetwork: false, priceMaxCents: 50_000_000 },
    };
    const changed = await app.inject({ method: 'PATCH', url: `/v1/sites/${site.id}`, headers, payload: patch });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ version: 2, inventoryPolicy: 'CUSTOM' });
    const stale = await app.inject({ method: 'PATCH', url: `/v1/sites/${site.id}`, headers, payload: patch });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/v1/sites/${site.id}`,
      headers,
      payload: { version: 2, inventoryPolicy: 'CUSTOM' },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it("[S7-01] another agency's site is not found; a key is bound to the site named", async () => {
    const f = await createFounder();
    const g = await createFounder();
    await setAgencyStatus(f.agencyId, 'VERIFIED');
    const headers = await bearer(f.userId, f.agencyId);
    const site = (await app.inject({ method: 'POST', url: '/v1/sites', headers, payload: SITE })).json() as {
      id: string;
    };
    const other = await app.inject({
      method: 'GET',
      url: `/v1/sites/${site.id}`,
      headers: await bearer(g.userId, g.agencyId),
    });
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe('SITE_NOT_FOUND');

    const key = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers,
      payload: { name: 'WP', kind: 'SECRET', scopes: ['listings:read'], siteId: site.id },
    });
    expect(key.statusCode).toBe(201);
    expect(key.json().key.siteId).toBe(site.id);
  });
});
