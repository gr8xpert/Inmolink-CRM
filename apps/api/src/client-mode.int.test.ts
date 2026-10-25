import { CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, pingDb, withMemberCtx } from '@inmolink/core';
import * as developments from '@inmolink/core/modules/developments';
import * as identity from '@inmolink/core/modules/identity';
import * as properties from '@inmolink/core/modules/properties';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder, withSystem } from '@inmolink/core/test';
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

/**
 * Client Mode over HTTP (S12-06): every registered dashboard route is called with a Client Mode token — reads with
 * the ids of an own listing, a network listing and an own development, writes with an empty body — and no answer
 * may carry commission, the owner agency, internal notes or private fields. The serializers must do it themselves:
 * the response net (`clientModePlugin`) may not have had to strip anything.
 */

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  consumeMany: async (checks: unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 })),
} as unknown as RateLimiter;

const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (m: Founder, cm: boolean) => ({
  authorization: `Bearer ${(await signer.sign({ sub: m.userId, aud: 'api', sv: 1, agency: m.agencyId, cm })).token}`,
});

const RUN = newId().slice(-8);
const NOTE_A = `own-internal-note-${RUN}`;
const NOTE_B = `owner-internal-note-${RUN}`;
const KEYS_A = `keys-at-the-office-${RUN}`;
const CADASTRE_A = `CAD${RUN}`.slice(0, 20);
const OWNER_MAIL = `sales-${RUN.toLowerCase()}@owner-agency.example`;
const OWNER_PHONE = '+34 952 761 234';

/** Warnings of the response net ("stripped by the net"): must stay empty. */
const netWarnings: string[] = [];
const logger = createLogger({
  level: 'warn',
  destination: {
    write(line: string) {
      if (line.includes('client mode: response field stripped')) netWarnings.push(line);
    },
  },
});

const build = () =>
  buildApp({
    logger,
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
const ids = { ownListing: '', networkListing: '', development: '' };

async function seedListing(
  m: Founder,
  place: { locationId: string; propertyTypeId: string },
  note: string,
  description: string,
) {
  return withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, async (ctx) => {
    const created = await properties.createListing(
      ctx,
      CreateListingBody.parse({
        ...place,
        priceCents: 45_000_000,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 400, includesVat: false },
        splitBp: 5_000,
        internalNotes: note,
        keysInfo: KEYS_A,
        cadastralRef: CADASTRE_A,
        coordinates: { lat: 36.51, lng: -4.88 },
      }),
    );
    const listing = await properties.updateListing(
      ctx,
      created.id,
      UpdateListingBody.parse({ status: 'ACTIVE', visibility: 'SHARED', shareScope: 'ALL', version: created.version }),
    );
    // S12-06 review: the owner's own text, with its contacts in it (the network listing's must be white-labelled).
    await properties.saveListingTranslation(ctx, listing.id, 'en', {
      version: listing.version,
      title: 'Sea view villa',
      description,
    });
    return listing.id;
  });
}

beforeAll(async () => {
  // 'worker': the seed creates taxonomy through `withSystem`; the routes still run as `app_user` (withTenant).
  await setupTestDb('worker');
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789' });
  app = await build();
  [a, b] = [await createFounder(), await createFounder()];
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const place = await withSystem('client-mode.int.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const locationId = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `cm-${RUN}`,
      translations: name('Clientland'),
    });
    const groupId = await taxonomy.createPropertyTypeGroup(tx, {
      key: `cm-g-${RUN}`,
      sort: 0,
      translations: name('G'),
    });
    const propertyTypeId = await taxonomy.createPropertyType(tx, {
      groupId,
      key: `cm-t-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { locationId, propertyTypeId };
  });
  ids.ownListing = await seedListing(a, place, NOTE_A, 'Our villa with a sea view.');
  ids.networkListing = await seedListing(
    b,
    place,
    NOTE_B,
    `Villa with a sea view. Call ${OWNER_PHONE} or ${OWNER_MAIL}.`,
  );
  ids.development = (
    await withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, (ctx) =>
      developments.createDevelopment(ctx, {
        ref: `CM-${RUN}`,
        name: `Client Mode Towers ${RUN}`,
        locationId: place.locationId,
        commission: { type: 'PCT', basisPoints: 350, includesVat: false },
      }),
    )
  ).id;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

/** The route's URL with its parameters filled: the seeded ids where they fit, a random id otherwise. */
function urlFor(url: string, listingId: string): string {
  return url.replace(/:(\w+)/g, (_m, name: string) => {
    if (name === 'id' && url.startsWith('/v1/listings/')) return listingId;
    if (name === 'id' && url.startsWith('/v1/developments/')) return ids.development;
    return newId();
  });
}

describe('Client Mode over every route (S12-06)', () => {
  it('[S12-06] with Client Mode on, no API response contains commission, owner agency, internal notes or private fields', async () => {
    const headers = await bearer(a, true);
    const routes = app.registeredRoutes.filter(
      (r) => r.url.startsWith('/v1/') && !['HEAD', 'OPTIONS'].includes(r.method),
    );
    expect(routes.length).toBeGreaterThan(200);
    const leaks: string[] = [];
    const answered: string[] = [];
    for (const route of routes) {
      const passes = route.url.startsWith('/v1/listings/:id') ? [ids.ownListing, ids.networkListing] : [ids.ownListing];
      for (const listingId of passes) {
        const url = urlFor(route.url, listingId);
        const res = await app.inject({
          method: route.method as 'GET',
          url,
          headers,
          ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
        });
        if (res.statusCode >= 300) continue;
        answered.push(`${route.method} ${route.url}`);
        const body = res.body;
        for (const secret of [NOTE_A, NOTE_B, KEYS_A, CADASTRE_A, b.agencyId, OWNER_MAIL, OWNER_PHONE]) {
          if (body.includes(secret)) leaks.push(`${route.method} ${url}: ${secret}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    // The serializers stripped everything themselves: the net never had to.
    expect(netWarnings).toEqual([]);
    // The reads Client Mode keeps did answer (the check above is not vacuous).
    expect(answered).toEqual(
      expect.arrayContaining([
        'GET /v1/me/capabilities',
        'GET /v1/listings',
        'GET /v1/listings/:id',
        'GET /v1/developments/:id',
      ]),
    );
  }, 600_000);

  it('[S12-06] the listing and development reads in Client Mode: no commission, notes or private data, no owner agency', async () => {
    const cm = await bearer(a, true);
    const caps = await app.inject({ method: 'GET', url: '/v1/me/capabilities', headers: cm });
    expect(caps.json()).toMatchObject({ clientMode: true });
    const own = (await app.inject({ method: 'GET', url: `/v1/listings/${ids.ownListing}`, headers: cm })).json();
    expect(own).toMatchObject({ id: ids.ownListing, commission: null, private: null });
    expect(own.internalNotes ?? null).toBeNull();
    const network = await app.inject({ method: 'GET', url: `/v1/listings/${ids.networkListing}`, headers: cm });
    expect(network.statusCode).toBe(200);
    expect(network.json()).toMatchObject({
      id: ids.networkListing,
      agencyId: null,
      ownerUserId: null,
      commission: null,
    });
    // The owner's own text of a network listing comes white-labelled (S12-06 review).
    const content = await app.inject({ method: 'GET', url: `/v1/listings/${ids.networkListing}/content`, headers: cm });
    expect(content.statusCode).toBe(200);
    expect(content.json().translations[0].description).toContain('Villa with a sea view.');
    expect(content.body).not.toContain(OWNER_MAIL);
    expect(content.body).not.toContain('952');
    const dev = (await app.inject({ method: 'GET', url: `/v1/developments/${ids.development}`, headers: cm })).json();
    expect(dev).toMatchObject({ id: ids.development, commission: null, access: null });

    // The same member outside Client Mode sees them (the seed is what the first check looked for).
    const plain = await bearer(a, false);
    const full = (await app.inject({ method: 'GET', url: `/v1/listings/${ids.ownListing}`, headers: plain })).json();
    expect(full.commission).not.toBeNull();
    expect(JSON.stringify(full)).toContain(NOTE_A);
    expect((await app.inject({ method: 'GET', url: '/v1/me/capabilities', headers: plain })).json()).toMatchObject({
      clientMode: false,
    });
  });

  it('[S12-06] starting Client Mode: a PIN of the policy length returns a proof; in Client Mode it is refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session/client-mode',
      headers: await bearer(a, false),
      payload: { pin: '482193' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(identity.openClientModeProof({ userId: a.userId, proof: res.json().proof })).not.toBeNull();
    const short = await app.inject({
      method: 'POST',
      url: '/v1/session/client-mode',
      headers: await bearer(a, false),
      payload: { pin: '12a4' },
    });
    expect(short.statusCode).toBe(422);
    const again = await app.inject({
      method: 'POST',
      url: '/v1/session/client-mode',
      headers: await bearer(a, true),
      payload: { pin: '482193' },
    });
    expect(again.statusCode).toBe(403);
  });
});

/**
 * S13-F4: the S12 dashboards a client must never see. Each route gets a body its schema accepts, so the refusal is
 * the policy's (403), not validation's. A new route under these prefixes fails the first check until it is listed.
 */
const CLIENT_MODE_REFUSED: Record<string, (() => unknown) | null> = {
  'GET /v1/social/accounts': null,
  'POST /v1/social/connect': null,
  'POST /v1/social/connect/callback': () => ({ code: 'meta-code', state: 'meta-state' }),
  'DELETE /v1/social/accounts/:accountId': null,
  'GET /v1/social/posts': null,
  'POST /v1/social/posts': () => ({ accountId: newId(), listingId: ids.ownListing, locale: 'en', caption: 'Hi' }),
  'GET /v1/social/posts/:postId': null,
  'PATCH /v1/social/posts/:postId': () => ({ version: 1, caption: 'Hi' }),
  'POST /v1/social/posts/:postId/captions': () => ({ version: 1, locales: ['en'] }),
  'POST /v1/social/posts/:postId/cancel': () => ({ version: 1 }),
  'GET /v1/selections': null,
  'POST /v1/selections': () => ({ title: 'For you', locale: 'en', items: [{ targetId: ids.ownListing }] }),
  'GET /v1/selections/:id': null,
  'PATCH /v1/selections/:id': () => ({ version: 1, title: 'For you' }),
  'POST /v1/selections/:id/pdf': null,
  'POST /v1/selections/:id/link': () => ({ version: 1 }),
  'GET /v1/selections/:id/interactions': null,
  'GET /v1/saved-searches': null,
  'POST /v1/saved-searches': () => ({ name: 'Sea views' }),
  'PUT /v1/saved-searches/:id': () => ({ name: 'Sea views' }),
  'DELETE /v1/saved-searches/:id': null,
  'POST /v1/listings/:id/studio': () => ({}),
};

describe('Client Mode refusals (S13-F4)', () => {
  it('[S13-F4] a Client Mode token gets 403 on /v1/social/*, /v1/selections*, /v1/saved-searches* and the Listing Studio', async () => {
    const covered = app.registeredRoutes
      .filter((r) => !['HEAD', 'OPTIONS'].includes(r.method))
      .filter((r) => /^\/v1\/(social\/|selections|saved-searches)/.test(r.url) || r.url === '/v1/listings/:id/studio')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(covered).toEqual(Object.keys(CLIENT_MODE_REFUSED).sort());

    const cm = await bearer(a, true);
    const plain = await bearer(a, false);
    const answers: string[] = [];
    const notRefused: string[] = [];
    for (const [route, body] of Object.entries(CLIENT_MODE_REFUSED)) {
      const [method, pattern] = route.split(' ') as [string, string];
      const url = urlFor(pattern, ids.ownListing);
      const call = (headers: Record<string, string>) =>
        app.inject({ method: method as 'GET', url, headers, ...(body ? { payload: body() as object } : {}) });
      const res = await call(cm);
      if (res.statusCode !== 403 || res.json().error?.code !== 'FORBIDDEN') {
        notRefused.push(`${route}: ${res.statusCode} ${res.body.slice(0, 200)}`);
      }
      // The same lists outside Client Mode: they answer, or social's flag (off by default, H3) refuses with its own
      // code — so the FORBIDDEN above is the Client Mode policy's, checked before the flag.
      if (method === 'GET' && !pattern.includes(':')) {
        const out = await call(plain);
        answers.push(`${route}: ${out.statusCode === 200 ? 200 : out.json().error?.code}`);
      }
    }
    expect(notRefused).toEqual([]);
    expect(answers).toEqual([
      'GET /v1/social/accounts: SOCIAL_NOT_ENABLED',
      'GET /v1/social/posts: SOCIAL_NOT_ENABLED',
      'GET /v1/selections: 200',
      'GET /v1/saved-searches: 200',
    ]);
  });
});
