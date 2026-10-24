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
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/** CRM contacts over HTTP (S10-01): duplicate → 409 with the matches → merge; CSV upload and start. */

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
const RUN = newId().slice(-8).toLowerCase();

beforeAll(async () => {
  await setupTestDb('http');
  configureStorage(createMemoryStore());
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe('crm contact routes', () => {
  it('[S10-01] creating a contact with an existing email answers 409 with the match; mergeInto adds to it', async () => {
    const f = await createFounder();
    const headers = await bearer(f.userId, f.agencyId);
    const email = `api-${RUN}@example.com`;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/crm/contacts',
      headers,
      payload: { firstName: 'Rosa', emails: [email], phones: ['600 111 222'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const contact = created.json();
    expect(contact).toMatchObject({
      emails: [email],
      phones: ['+34600111222'],
      source: 'MANUAL',
      ownerUserId: f.userId,
    });

    const dup = await app.inject({
      method: 'POST',
      url: '/v1/crm/contacts',
      headers,
      payload: { firstName: 'Rosa M', emails: [email.toUpperCase()], tags: ['web'] },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({
      code: 'CONTACT_DUPLICATE',
      details: { matches: [{ contactId: contact.id, on: 'email' }] },
    });

    const merged = await app.inject({
      method: 'POST',
      url: '/v1/crm/contacts',
      headers,
      payload: { firstName: 'Rosa M', emails: [email], tags: ['web'], mergeInto: contact.id },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ id: contact.id, firstName: 'Rosa', tags: ['web'] });

    const found = await app.inject({
      method: 'POST',
      url: '/v1/crm/contacts/lookup',
      headers,
      payload: { emails: [email] },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().items.map((c: { id: string }) => c.id)).toEqual([contact.id]);

    const note = await app.inject({
      method: 'POST',
      url: `/v1/crm/contacts/${contact.id}/notes`,
      headers,
      payload: { body: 'Prefers WhatsApp' },
    });
    expect(note.statusCode).toBe(201);
  });

  it('[S10-01] a create retried with the same Idempotency-Key answers the first contact (200)', async () => {
    const f = await createFounder();
    const headers = { ...(await bearer(f.userId, f.agencyId)), 'idempotency-key': `crm-api-${RUN}-retry-key` };
    const payload = { firstName: 'Tea', emails: [`idem-${RUN}@example.com`] };
    const first = await app.inject({ method: 'POST', url: '/v1/crm/contacts', headers, payload });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: '/v1/crm/contacts', headers, payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
  });

  it('[S10-01] a CSV upload answers its header and first rows; start queues the import (202)', async () => {
    const f = await createFounder();
    const headers = await bearer(f.userId, f.agencyId);
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/crm/contact-imports',
      headers: { ...headers, 'content-type': 'text/csv' },
      payload: `Name,Email\nSol,sol-${RUN}@example.com\n`,
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json();
    expect(body).toMatchObject({ kind: 'csv', headers: ['Name', 'Email'], suggested: { fullName: 0, emails: [1] } });
    const start = await app.inject({
      method: 'POST',
      url: `/v1/crm/contact-imports/${body.id}/start`,
      headers,
      payload: { mapping: { fullName: 0, emails: [1] } },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json()).toMatchObject({ id: body.id, status: 'QUEUED' });
  });
});
