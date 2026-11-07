import { closeDb, pingDb } from '@inmolink/core';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, withSystem } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
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

/** R2-07a: a development's units read from a Kyero file over HTTP (raw XML body, content checks, owner only). */

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
  await setupTestDb('worker');
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

async function verified() {
  const f = await createFounder();
  await setAgencyStatus(f.agencyId, 'VERIFIED');
  return { ...f, headers: await bearer(f.userId, f.agencyId) };
}

describe('Kyero units route', () => {
  it('[R2-07] reads an uploaded Kyero file as units for the owner only; refuses other bodies', async () => {
    const RUN = newId().slice(-8);
    const owner = await verified();
    const other = await verified();
    const place = await withSystem('developments-kyero.int.test', async (tx) => {
      const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
      const locationId = await taxonomy.createLocation(tx, {
        level: 'COUNTRY',
        parentId: null,
        code: `ky-${RUN}`,
        translations: name('Kyland'),
      });
      const groupId = await taxonomy.createPropertyTypeGroup(tx, {
        key: `ky-g-${RUN}`,
        sort: 0,
        translations: name('G'),
      });
      const typeId = await taxonomy.createPropertyType(tx, {
        groupId,
        key: `ky-t-${RUN}`,
        sort: 0,
        translations: name('Villa'),
      });
      return { locationId, typeId };
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/developments',
      headers: owner.headers,
      payload: { ref: `KY-${RUN}`, name: 'Kyero Heights', locationId: place.locationId },
    });
    expect(created.statusCode).toBe(201);
    const url = `/v1/developments/${(created.json() as { id: string }).id}/units/kyero`;
    const file = `<?xml version="1.0"?><root><property><id>K-1</id><type>Villa ${RUN}</type><price>200000</price></property></root>`;
    const xml = (headers: Record<string, string>, payload: string | Buffer, type = 'application/xml') =>
      app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': type }, payload });

    const ok = await xml(owner.headers, file, 'text/xml');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      units: [
        {
          ref: 'K-1',
          propertyTypeId: place.typeId,
          priceCents: 20_000_000,
          bedrooms: null,
          bathrooms: null,
          internalM2: null,
          plotM2: null,
        },
      ],
      problems: [],
      moreProblems: 0,
    });
    // Another agency does not see the (unshared) development at all.
    expect((await xml(other.headers, file)).statusCode).toBe(404);
    // Only XML bodies reach the route; a JSON body is refused before any work.
    const json = await app.inject({ method: 'POST', url, headers: owner.headers, payload: { units: [] } });
    expect(json.statusCode).toBe(415);
    // The content decides, not the header: a PDF sent as XML is refused.
    const pdf = await xml(owner.headers, '%PDF-1.7');
    expect(pdf.statusCode).toBe(422);
    expect(pdf.json()).toMatchObject({ error: { code: 'KYERO_FILE_INVALID' } });
    expect((await xml(owner.headers, Buffer.alloc(5 * 1024 * 1024 + 10, 0x3c))).statusCode).toBe(413);
  });
});
