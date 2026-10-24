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

describe('crm lead routes', () => {
  it('[S10-02] a lead entered by hand lands in the inbox; status, assignment and the rule over HTTP', async () => {
    const f = await createFounder();
    const headers = await bearer(f.userId, f.agencyId);
    const contact = (
      await app.inject({
        method: 'POST',
        url: '/v1/crm/contacts',
        headers,
        payload: { firstName: 'Leo', emails: [`api-lead-${RUN}@example.com`] },
      })
    ).json();
    const key = { 'idempotency-key': `api-lead-${RUN}-0001` };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/crm/leads',
      headers: { ...headers, ...key },
      payload: { contactId: contact.id, message: 'Wants a sea view' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const lead = created.json();
    expect(lead).toMatchObject({ source: 'MANUAL', status: 'NEW', contact: { id: contact.id }, assignedUserId: null });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/crm/leads',
      headers: { ...headers, ...key },
      payload: { contactId: contact.id, message: 'Wants a sea view' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(lead.id);

    const inbox = await app.inject({ method: 'GET', url: '/v1/crm/leads?status=NEW&limit=10', headers });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().items.map((l: { id: string }) => l.id)).toEqual([lead.id]);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      headers,
      payload: { version: lead.version, status: 'IN_PROGRESS', assignedUserId: f.userId },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ status: 'IN_PROGRESS', assignedUserId: f.userId });
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      headers,
      payload: { version: lead.version, status: 'WON' },
    });
    expect(stale.statusCode).toBe(409);

    const rule = await app.inject({
      method: 'PUT',
      url: '/v1/crm/lead-routing',
      headers,
      payload: { version: 0, mode: 'ROUND_ROBIN', agentUserIds: [f.userId] },
    });
    expect(rule.statusCode).toBe(200);
    expect(rule.json()).toEqual({ mode: 'ROUND_ROBIN', agentUserIds: [f.userId], version: 1 });
    const intros = await app.inject({ method: 'GET', url: '/v1/crm/lead-introductions', headers });
    expect(intros.statusCode).toBe(200);
    expect(intros.json()).toEqual({ items: [], nextCursor: null });
  });
});

describe('crm activity routes', () => {
  it('[S10-04] a call logged over HTTP is on the contact’s timeline; Idempotency-Key replays; filters validated', async () => {
    const f = await createFounder();
    const headers = await bearer(f.userId, f.agencyId);
    const contact = (
      await app.inject({
        method: 'POST',
        url: '/v1/crm/contacts',
        headers,
        payload: { firstName: 'Tim', emails: [`api-activity-${RUN}@example.com`] },
      })
    ).json();
    const key = { 'idempotency-key': `api-activity-${RUN}-0001` };
    const payload = { type: 'CALL', contactId: contact.id, body: 'Called back about the terrace' };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/crm/activities',
      headers: { ...headers, ...key },
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const activity = created.json();
    expect(activity).toMatchObject({ type: 'CALL', contactId: contact.id, actorUserId: f.userId, data: {} });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/crm/activities',
      headers: { ...headers, ...key },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(activity.id);
    await app.inject({
      method: 'POST',
      url: `/v1/crm/contacts/${contact.id}/notes`,
      headers,
      payload: { body: 'Sea view only' },
    });

    const all = await app.inject({
      method: 'GET',
      url: `/v1/crm/activities?subject=CONTACT&subjectId=${contact.id}`,
      headers,
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().items.map((i: { type: string }) => i.type)).toEqual(['NOTE_ADDED', 'CALL']);
    const calls = await app.inject({
      method: 'GET',
      url: `/v1/crm/activities?subject=CONTACT&subjectId=${contact.id}&type=CALL&limit=10`,
      headers,
    });
    expect(calls.json()).toEqual({ items: [activity], nextCursor: null });

    const half = await app.inject({ method: 'GET', url: '/v1/crm/activities?subject=CONTACT', headers });
    expect(half.statusCode).toBe(422);
    const badType = await app.inject({ method: 'GET', url: '/v1/crm/activities?type=NOPE', headers });
    expect(badType.statusCode).toBe(422);
    const none = await app.inject({ method: 'POST', url: '/v1/crm/activities', headers, payload: { type: 'CALL' } });
    expect(none.statusCode).toBe(422);
  });
});
