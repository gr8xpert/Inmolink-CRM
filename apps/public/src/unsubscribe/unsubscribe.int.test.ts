import { CreateContactBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import * as presentations from '@inmolink/core/modules/presentations';
import { createFounder, type Founder, whiteLabelLeaks } from '@inmolink/core/test';
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as route from '@/app/u/[token]/route';
import { unsubscribeActionResponse, unsubscribeResponse } from './handlers';

/**
 * The unsubscribe link as served (R2-02g): `GET /u/<token>` — a confirm page in the client's language, branded as the
 * agency, that changes nothing; `POST /u/<token>` — one-click (RFC 8058) or the button: 200 and the request recorded;
 * a forged link: a neutral 404. Rate-limited per client address and per link.
 */

const { BUCKET } = vi.hoisted(() => ({ BUCKET: `198.51.100.9-${Math.random().toString(36).slice(2)}` }));
vi.mock('@/server/embed', () => ({
  clientAddress: async () => ({ ip: '198.51.100.9', bucket: BUCKET }),
  embedPageConfig: async () => ({ mediaOrigin: 'https://media.example', turnstileSiteKey: null }),
}));
vi.mock('@/server/env', () => ({
  publicConfig: async () => ({ NODE_ENV: 'test', PUBLIC_URL: 'https://sites.test' }),
  LOCAL_PUBLIC_URL: 'http://localhost:3101',
}));

const RUN = newId().slice(-8);
const KEY = 'test-hmac-key-0123456789abcdef0123456789';
const OTHER_NAME = `Otherhaus Bajas ${RUN}`;

let a: Founder;
let b: Founder;
let contactId = '';
let email = '';
let token = '';

const get = (path: string) => unsubscribeResponse(new Request(`https://sites.test${path}`), token);
/** A mail provider's RFC 8058 one-click: no cookie, no Origin, the fixed body. */
const oneClick = (t: string, query = '') =>
  unsubscribeActionResponse(
    new Request(`https://sites.test/u/${t}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    }),
    t,
  );
const requests = async () =>
  (
    await adminQuery<{ n: number }>(
      `select count(*)::int as n from outbox_events
        where agency_id = $1 and processed_at is null
          and type = 'crm.contact.unsubscribeRequested' and payload ->> 'contactId' = $2`,
      [a.agencyId, contactId],
    )
  )[0]?.n ?? 0;

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:unsub:${RUN}`, commandTimeoutMs: 2_000 });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  presentations.configurePresentations({ tokenKey: KEY, publicBaseUrl: 'https://sites.test' });
  crm.configureUnsubscribeLinks({ tokenKey: KEY, publicBaseUrl: 'https://sites.test' });
  a = await createFounder();
  b = await createFounder({ companyName: OTHER_NAME });
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  email = `client-${RUN.toLowerCase()}@example.com`;
  const c = await withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, (ctx) =>
    crm.createContact(
      ctx,
      CreateContactBody.parse({ firstName: 'Lucía', emails: [email], language: 'es', consentMarketing: true }),
    ),
  );
  contactId = c.contact.id;
  token = crm.unsubscribeToken(a.agencyId, contactId);
}, 240_000);

afterAll(async () => {
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

describe('the unsubscribe page (R2-02g)', () => {
  it('[R2-02g] the confirm page in ES and EN, branded as the agency; GET does not unsubscribe', async () => {
    const es = await get(`/u/${token}?l=es`);
    expect(es.status).toBe(200);
    const esBody = await es.text();
    expect(esBody).toContain('<html lang="es"');
    expect(esBody).toContain('Darse de baja de las alertas de propiedades');
    expect(esBody).toContain('¿Quieres dejar de recibir por correo alertas de propiedades de Costa Homes S.L.?');
    expect(esBody).toContain(`action="/u/${token}?l=es"`);
    expect(esBody).toContain('name="List-Unsubscribe" value="One-Click"');
    const en = await (await get(`/u/${token}?l=en`)).text();
    expect(en).toContain('<html lang="en"');
    expect(en).toContain('Do you want to stop receiving property alerts from Costa Homes S.L. by e-mail?');
    // an unknown language is English, never echoed
    expect(await (await get(`/u/${token}?l=%22%3E%3Cx`)).text()).toContain('<html lang="en"');
    expect(await requests()).toBe(0);
  });

  it('[R2-02g] white-label: only the agency, never another agency or any contact data', async () => {
    const body = await (await get(`/u/${token}?l=es`)).text();
    expect(
      whiteLabelLeaks(body, {
        name: OTHER_NAME,
        email: b.email,
        domain: 'otherhaus-bajas.example',
        ref: 'OB-1',
        agencyId: b.agencyId,
      }),
    ).toEqual([]);
    for (const leak of [email, 'Lucía', contactId, a.agencyId, a.email]) expect(body).not.toContain(leak);
  });

  it('[R2-02g] one-click POST answers 200 with the done page in the client language and records the request', async () => {
    const res = await oneClick(token, '?l=es');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Te has dado de baja');
    expect(body).toContain('Costa Homes S.L.');
    expect(await requests()).toBe(1);
    expect((await (await oneClick(token, '?l=en')).text()).includes('You are unsubscribed')).toBe(true);
    expect(await requests()).toBe(2);
  });

  it('[R2-02g] a forged or tampered token: a neutral 404, the same for GET and POST, nothing recorded', async () => {
    const before = await requests();
    const forged = `${token.slice(0, 40)}${token.slice(40).split('').reverse().join('')}`;
    const other = crm.unsubscribeToken(newId(), newId()).replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A'));
    const pages: string[] = [];
    for (const t of [forged, other, 'short', 'x'.repeat(64)]) {
      const g = await unsubscribeResponse(new Request(`https://sites.test/u/${t}?l=es`), t);
      const p = await oneClick(t, '?l=es');
      expect([g.status, p.status], t).toEqual([404, 404]);
      pages.push(await g.text(), await p.text());
    }
    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).toContain('Este enlace no es válido');
    expect(pages[0]).not.toContain('Costa Homes');
    expect(await requests()).toBe(before);
  });

  it('[R2-02g] rate-limited: a link takes a few posts an hour, then 429 with Retry-After', async () => {
    const t = crm.unsubscribeToken(a.agencyId, newId());
    const statuses: number[] = [];
    for (let i = 0; i < crm.UNSUBSCRIBE_LIMITS.postsPerLinkPerHour + 1; i += 1)
      statuses.push((await oneClick(t)).status);
    expect(statuses.slice(0, -1).every((s) => s === 200)).toBe(true);
    const last = await oneClick(t);
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('[R2-02g] the route: GET and POST carry the private-page headers (no store, no referrer, no framing, noindex)', async () => {
    const ctx = { params: Promise.resolve({ token }) };
    for (const res of [
      await route.GET(new Request(`https://sites.test/u/${token}?l=es`), ctx),
      await route.POST(new Request(`https://sites.test/u/${token}`, { method: 'POST' }), ctx),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
    expect(route.dynamic).toBe('force-dynamic');
  });
});
