import { CreateContactBody, CreateFormDocumentBody, CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import * as documents from '@inmolink/core/modules/documents';
import * as properties from '@inmolink/core/modules/properties';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder, withSystem } from '@inmolink/core/test';
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { invalidateFlags, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { configurePdf } from '@inmolink/platform/pdf';
import { fakePdfRenderer } from '@inmolink/platform/pdf/testing';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as documentRoute from '@/app/sign/[token]/document/route';
import * as route from '@/app/sign/[token]/route';
import * as signedRoute from '@/app/sign/[token]/signed/route';
import * as assets from '@/app/sign-assets/[file]/route';
import { SIGNING_SCRIPT_PATH } from './client';

/**
 * The signing page as served (R2-05b): `GET /sign/<token>` — the document (label, SHA-256, a link to the PDF) and the
 * two forms, in the signer's language; `POST` with `action=code` (same origin only) appends the code request,
 * `action=sign` with a wrong code says so, with the right one records the signature; the PDF links redirect to a
 * short signed URL; a forged link is a neutral 404; the drawing script is served immutable from 'self'.
 */

const { BUCKET } = vi.hoisted(() => ({ BUCKET: `198.51.100.44-${Math.random().toString(36).slice(2)}` }));
vi.mock('@/server/embed', () => ({
  clientAddress: async () => ({ ip: '198.51.100.44', bucket: BUCKET }),
  embedPageConfig: async () => ({ mediaOrigin: 'https://media.example', turnstileSiteKey: null }),
}));
vi.mock('@/server/env', () => ({
  publicConfig: async () => ({ NODE_ENV: 'test', PUBLIC_URL: 'https://sites.test' }),
  LOCAL_PUBLIC_URL: 'http://localhost:3101',
}));

const RUN = newId().slice(-8).toLowerCase();
const KEY = 'test-hmac-key-signing-public-0123456789ab';
const ORIGIN = 'https://sites.test';

let a: Founder;
let token = '';
let signerId = '';
let sha256 = '';

const ctxOf = (token_: string) => ({ params: Promise.resolve({ token: token_ }) });
const get = (path: string, t = token) => route.GET(new Request(`${ORIGIN}${path}`), ctxOf(t));
const post = (body: Record<string, string>, origin: string | null = ORIGIN, t = token) =>
  route.POST(
    new Request(`${ORIGIN}/sign/${t}?l=en`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Signing page test',
        ...(origin ? { origin } : {}),
      },
      body: new URLSearchParams(body).toString(),
    }),
    ctxOf(t),
  );

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:sign:${RUN}`, commandTimeoutMs: 2_000 });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  configureStorage(createMemoryStore());
  configurePdf(fakePdfRenderer());
  documents.configureSigning({ tokenKey: KEY, publicBaseUrl: ORIGIN });
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  await withSystem('signing.test', async (tx) => {
    await setFlagOverride(tx, documents.FORMS_FLAG, a.agencyId, true);
    await setFlagOverride(tx, documents.ESIGN_FLAG, a.agencyId, true);
  });
  invalidateFlags();
  const ids = await withSystem('signing.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `signp-${RUN}`,
      translations: name('Signville'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `signp-g-${RUN}`,
      sort: 0,
      translations: name('H'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `signp-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  const { id: listingId } = await as((ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents: 45_000_000 }),
    ),
  );
  await as(async (ctx) =>
    properties.updateListing(
      ctx,
      listingId,
      UpdateListingBody.parse({ status: 'ACTIVE', version: (await properties.getListing(ctx, listingId)).version }),
    ),
  );
  const { contact } = await as((ctx) =>
    crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Lucía', lastName: `P${RUN}` })),
  );
  const { form } = await as((ctx) =>
    documents.createFormDocument(
      ctx,
      CreateFormDocumentBody.parse({
        template: 'OFFER',
        listingId,
        contactId: contact.id,
        offer: { amountCents: 40_000_000, currency: 'EUR' },
        validUntil: '2030-01-31',
        locale: 'en',
      }),
    ),
  );
  await documents.renderFormDocument(form.id, a.agencyId);
  const { request } = await as((ctx) =>
    documents.createSignatureRequest(ctx, form.id, {
      signers: [{ name: `Lucía P${RUN}`, email: `lucia-${RUN}@example.com`, role: 'buyer' }],
    }),
  );
  signerId = request.signers[0]?.id as string;
  sha256 = request.documentSha256;
  token = documents.signingToken(a.agencyId, signerId);
}, 240_000);

afterAll(async () => {
  await adminQuery('delete from form_documents where agency_id = $1', [a.agencyId]);
  await withSystem('signing.test', async (tx) => {
    await setFlagOverride(tx, documents.FORMS_FLAG, a.agencyId, null);
    await setFlagOverride(tx, documents.ESIGN_FLAG, a.agencyId, null);
  });
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

const events = async (kind: string) =>
  (
    await adminQuery<{ n: number }>(
      'select count(*)::int as n from signature_events where signer_id = $1 and kind = $2',
      [signerId, kind],
    )
  )[0]?.n ?? 0;

describe('the signing page (R2-05b)', () => {
  it('[R2-05b] GET shows the document, its SHA-256, the PDF link and both forms; nothing is recorded', async () => {
    const res = await get(`/sign/${token}?l=en`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const body = await res.text();
    expect(body).toContain('<html lang="en"');
    expect(body).toContain(sha256);
    expect(body).toContain(`href="/sign/${token}/document?l=en"`);
    expect(body).toContain(`action="/sign/${token}?l=en"`);
    expect(body).toContain('name="action" value="code"');
    expect(body).toContain('name="action" value="sign"');
    expect(body).toContain(`src="${SIGNING_SCRIPT_PATH}"`);
    expect(body).toContain('l•••@example.com');
    expect(body).not.toContain(`lucia-${RUN}@example.com`);
    expect(await (await get(`/sign/${token}?l=es`)).text()).toContain('Firmar un documento');
    expect(await events('OTP_SENT')).toBe(0);
  });

  it('[R2-05b] a forged link is a neutral 404 for GET and POST', async () => {
    const forged = `${token.slice(0, 60)}${token.slice(60).split('').reverse().join('')}`;
    const g = await get(`/sign/${forged}?l=en`, forged);
    expect(g.status).toBe(404);
    const body = await g.text();
    expect(body).not.toContain(sha256);
    expect((await post({ action: 'code' }, ORIGIN, forged)).status).toBe(404);
    expect((await post({ action: 'code' }, ORIGIN, 'short')).status).toBe(404);
  });

  it('[R2-05b] a code request: same origin only; appended with its event; signing needs the right code', async () => {
    expect((await post({ action: 'code' }, 'https://evil.example')).status).toBe(403);
    expect(await events('OTP_SENT')).toBe(0);
    const sent = await post({ action: 'code' });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain('We sent a code to l•••@example.com');
    expect(await events('OTP_SENT')).toBe(1);
    const [otp] = await adminQuery<{ id: string }>(
      "select id from signature_events where signer_id = $1 and kind = 'OTP_SENT'",
      [signerId],
    );
    const [evt] = await adminQuery<{ n: number }>(
      `select count(*)::int as n from outbox_events where agency_id = $1
        and type = 'documents.signature.codeRequested' and payload->>'otpId' = $2`,
      [a.agencyId, otp?.id],
    );
    expect(evt?.n).toBe(1);
    const code = documents.signingCode(otp?.id as string, signerId);
    const wrong = code === '000000' ? '111111' : '000000';
    const fields = { action: 'sign', kind: 'TYPED', name: 'Lucía P', consent: 'yes', documentSha256: sha256 };
    const bad = await post({ ...fields, code: wrong });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain('The code is not right. Attempts left for this code: 4.');
    const noConsent = await post({ ...fields, code, consent: '' });
    expect(noConsent.status).toBe(422);
    const ok = await post({ ...fields, code });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('your signature is recorded');
    expect(await events('SIGNED')).toBe(1);
    const [signed] = await adminQuery<{ ip: string; user_agent: string; signature_text: string }>(
      "select ip, user_agent, signature_text from signature_events where signer_id = $1 and kind = 'SIGNED'",
      [signerId],
    );
    expect(signed).toEqual({ ip: '198.51.100.44', user_agent: 'Signing page test', signature_text: 'Lucía P' });
    // signed: the page says so, a second submission records nothing
    expect(await (await get(`/sign/${token}?l=en`)).text()).toContain('Signed');
    await post({ ...fields, code });
    expect(await events('SIGNED')).toBe(1);
  });

  it('[R2-05b] the PDF links: a 303 to a short signed URL of the original; the signed one only once complete', async () => {
    const doc = await documentRoute.GET(new Request(`${ORIGIN}/sign/${token}/document?l=en`), ctxOf(token));
    expect(doc.status).toBe(303);
    expect(doc.headers.get('location')).toMatch(/^memory:\/\/.*form-documents.*expires=300/);
    expect(doc.headers.get('referrer-policy')).toBe('no-referrer');
    const signed = await signedRoute.GET(new Request(`${ORIGIN}/sign/${token}/signed?l=en`), ctxOf(token));
    expect(signed.status).toBe(404);
  });

  it('[R2-05b] the drawing script: immutable from self; any other name a 404', async () => {
    const file = SIGNING_SCRIPT_PATH.replace('/sign-assets/', '');
    const res = await assets.GET(new Request(`${ORIGIN}${SIGNING_SCRIPT_PATH}`), {
      params: Promise.resolve({ file }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toContain('data-sign-pad');
    const other = await assets.GET(new Request(`${ORIGIN}/sign-assets/x.js`), {
      params: Promise.resolve({ file: 'x.js' }),
    });
    expect(other.status).toBe(404);
  });
});
