import { SHEET_UPLOAD_MAX_BYTES } from '@inmolink/contracts';
import { closeDb, pingDb } from '@inmolink/core';
import * as imports from '@inmolink/core/modules/imports';
import { createFounder } from '@inmolink/core/test';
import { adminQuery, createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
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

/** Feed import routes over HTTP (S6-01). */

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

let app: Awaited<ReturnType<typeof build>>;
let unregister: () => void;

beforeAll(async () => {
  await setupTestDb('http');
  imports.configureImports({ keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }) });
  configureStorage(createMemoryStore());
  // The real connectors arrive with S6-03; the framework only needs one registered key.
  unregister = imports.registerConnector({
    key: 'api-test',
    fetch: async () => ({ body: (async function* () {})(), bytesRead: () => 0, contentType: null }),
    parse: async function* () {},
    map: () => ({ ok: false, problems: [{ code: 'UNUSED' }] }),
    validate: () => [],
  });
  app = await build();
}, 120_000);

afterAll(async () => {
  unregister();
  await app?.close();
  await closeDb();
});

describe('feed import routes', () => {
  it('[S6-01] admins connect a feed (credentials write-only), run it once at a time and read its history', async () => {
    const owner = await createFounder();
    const headers = await bearer(owner.userId, owner.agencyId);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/imports/connections',
      headers,
      payload: {
        name: 'Main feed',
        connector: 'api-test',
        url: 'https://feeds.example.com/kyero.xml',
        credentials: { type: 'basic', username: 'u', password: 'top-secret-pass' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('top-secret-pass');
    const connection = created.json() as { id: string; hasCredentials: boolean; scheduleMinutes: number };
    expect(connection).toMatchObject({ hasCredentials: true, scheduleMinutes: 1440 });

    const runs = `/v1/imports/connections/${connection.id}/runs`;
    const first = await app.inject({ method: 'POST', url: runs, headers });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ state: 'QUEUED', trigger: 'MANUAL' });
    const second = await app.inject({ method: 'POST', url: runs, headers });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'FEED_RUN_ACTIVE' } });

    const history = await app.inject({ method: 'GET', url: runs, headers });
    expect(history.statusCode).toBe(200);
    expect((history.json() as { items: unknown[] }).items).toHaveLength(1);

    const stranger = await createFounder();
    const theirs = await app.inject({
      method: 'GET',
      url: `/v1/imports/connections/${connection.id}`,
      headers: await bearer(stranger.userId, stranger.agencyId),
    });
    expect(theirs.statusCode).toBe(404);
  });

  it('[S6-08] a paused feed refuses "run now", shows its pause, appears on the staff health dashboard and resumes', async () => {
    const owner = await createFounder();
    const headers = await bearer(owner.userId, owner.agencyId);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/imports/connections',
      headers,
      payload: { name: 'Guarded feed', connector: 'api-test', url: 'https://feeds.example.com/guarded.xml' },
    });
    const { id } = created.json() as { id: string };
    // what the worker's anomaly guard writes (S6-08 runner)
    await adminQuery(
      `update feed_connections set paused_at = now(), pause_reason = 'MASS_WITHDRAWAL',
         pause_details = '{"missing": 40, "live": 100, "ratio": 0.3}' where id = $1`,
      [id],
    );
    const run = await app.inject({ method: 'POST', url: `/v1/imports/connections/${id}/runs`, headers });
    expect(run.statusCode).toBe(409);
    expect(run.json()).toMatchObject({ error: { code: 'FEED_CONNECTION_PAUSED' } });
    const shown = await app.inject({ method: 'GET', url: `/v1/imports/connections/${id}`, headers });
    expect(shown.json()).toMatchObject({ pause: { reason: 'MASS_WITHDRAWAL', details: { missing: 40, live: 100 } } });

    // staff only: a member gets 403, staff see the paused feed
    const notStaff = await app.inject({ method: 'GET', url: '/v1/staff/imports/health', headers });
    expect(notStaff.statusCode).toBe(403);
    const ops = await createStaffUser('STAFF_DATA_OPS');
    const staffHeaders = await bearer(ops.userId);
    const health = await app.inject({ method: 'GET', url: '/v1/staff/imports/health', headers: staffHeaders });
    expect(health.statusCode).toBe(200);
    expect(health.headers['cache-control']).toBe('no-store');
    const body = health.json() as { paused: { connectionId: string }[] };
    expect(body.paused.some((p) => p.connectionId === id)).toBe(true);

    // the agency admin resumes, accepting the change
    const resumed = await app.inject({
      method: 'POST',
      url: `/v1/imports/connections/${id}/resume`,
      headers,
      payload: { acceptChange: true },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ pause: null, acceptAnomalyOnce: true });
    const again = await app.inject({ method: 'POST', url: `/v1/imports/connections/${id}/runs`, headers });
    expect(again.statusCode).toBe(202);

    // staff resume answers for an unknown connection with 404
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/staff/imports/connections/01900000-0000-7000-8000-00000000dead/resume',
      headers: staffHeaders,
      payload: { acceptChange: false, reason: 'Ticket 12: checking an unknown connection' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('[S7-F1] a staff resume without a reason is refused (422); with one it resumes', async () => {
    const owner = await createFounder();
    const headers = await bearer(owner.userId, owner.agencyId);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/imports/connections',
      headers,
      payload: { name: 'Empty feed', connector: 'api-test', url: 'https://feeds.example.com/empty.xml' },
    });
    const { id } = created.json() as { id: string };
    await adminQuery(
      `update feed_connections set paused_at = now(), pause_reason = 'EMPTY_FEED',
         pause_details = '{"items": 0, "live": 12}' where id = $1`,
      [id],
    );
    const shown = await app.inject({ method: 'GET', url: `/v1/imports/connections/${id}`, headers });
    expect(shown.json()).toMatchObject({ pause: { reason: 'EMPTY_FEED', details: { items: 0, live: 12 } } });

    const staffHeaders = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const url = `/v1/staff/imports/connections/${id}/resume`;
    for (const payload of [{ acceptChange: false }, { acceptChange: false, reason: 'short' }]) {
      const refused = await app.inject({ method: 'POST', url, headers: staffHeaders, payload });
      expect(refused.statusCode, JSON.stringify(payload)).toBe(422);
    }
    const resumed = await app.inject({
      method: 'POST',
      url,
      headers: staffHeaders,
      payload: { acceptChange: false, reason: 'Ticket 99: the agency fixed its CRM export' },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ id, pause: null });
  });

  it('[S7-F1] the sheet upload refuses a member who may not manage imports before reading the 25 MB body', async () => {
    const owner = await createFounder();
    const agentId = newId();
    await adminQuery(
      `insert into users (id, email, password_hash, name, locale, status)
         values ($1, $2, 'x', 'Agent', 'en', 'ACTIVE')`,
      [agentId, `api-sheet-agent-${agentId}@example.com`],
    );
    await adminQuery(
      `insert into agency_members (agency_id, user_id, role, name, email) values ($1, $2, 'AGENT', 'Agent', $3)`,
      [owner.agencyId, agentId, `api-sheet-agent-${agentId}@example.com`],
    );
    const agentHeaders = await bearer(agentId, owner.agencyId);
    // over the body limit: an admin gets 413 (the body is read), a member 403 before any of it is
    const tooBig = Buffer.alloc(SHEET_UPLOAD_MAX_BYTES + 1, 0x41);
    const member = await app.inject({
      method: 'POST',
      url: '/v1/imports/sheets',
      headers: { ...agentHeaders, 'content-type': 'text/csv' },
      payload: tooBig,
    });
    expect(member.statusCode).toBe(403);
    const admin = await app.inject({
      method: 'POST',
      url: '/v1/imports/sheets',
      headers: { ...(await bearer(owner.userId, owner.agencyId)), 'content-type': 'text/csv' },
      payload: tooBig,
    });
    expect(admin.statusCode).toBe(413);
  });

  it('[S6-01] a feed URL naming a private, loopback or metadata address is refused', async () => {
    const owner = await createFounder();
    const headers = await bearer(owner.userId, owner.agencyId);
    for (const url of ['http://169.254.169.254/latest/', 'http://127.0.0.1:8080/feed', 'http://[fd00:ec2::254]/']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/imports/connections',
        headers,
        payload: { name: 'Bad feed', connector: 'api-test', url },
      });
      expect(res.statusCode, url).toBe(422);
      expect(res.json(), url).toMatchObject({ error: { code: 'FEED_URL_NOT_ALLOWED' } });
    }
  });

  it('[S6-04] the mapper routes: an XML upload is read by its bytes, a profile is saved, a mapping is previewed and dry-run, non-XML and private URLs are refused', async () => {
    const owner = await createFounder();
    const headers = await bearer(owner.userId, owner.agencyId);
    const xml = `<?xml version="1.0"?><feed>${[1, 2, 3]
      .map((i) => `<item code="A${i}"><kind>Villa</kind><cost>${i}00000</cost><town>Nowhere</town></item>`)
      .join('')}</feed>`;

    const sample = await app.inject({
      method: 'POST',
      url: '/v1/imports/mapper/sample',
      headers: { ...headers, 'content-type': 'application/xml' },
      payload: xml,
    });
    expect(sample.statusCode).toBe(200);
    const body = sample.json() as {
      recordElement: string;
      recordCount: number;
      paths: { path: string }[];
      records: unknown[];
    };
    expect(body).toMatchObject({ recordElement: 'item', recordCount: 3 });
    expect(body.paths.map((p) => p.path)).toEqual(expect.arrayContaining(['@code', 'kind', 'cost', 'town']));

    // not XML: refused by its first bytes, whatever the declared type says
    const zip = await app.inject({
      method: 'POST',
      url: '/v1/imports/mapper/sample',
      headers: { ...headers, 'content-type': 'application/xml' },
      payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x3c, 0x61, 0x3e]),
    });
    expect(zip.statusCode).toBe(422);
    expect(zip.json()).toMatchObject({ error: { code: 'FEED_SAMPLE_INVALID' } });
    const json = await app.inject({
      method: 'POST',
      url: '/v1/imports/mapper/sample',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { a: 1 },
    });
    expect(json.statusCode).toBeGreaterThanOrEqual(400);

    const mapping = {
      schemaVersion: 1,
      recordElement: 'item',
      fields: {
        ref: { path: '@code' },
        propertyType: { path: 'kind' },
        price: { path: 'cost' },
        city: { path: 'town' },
      },
    };
    const preview = await app.inject({
      method: 'POST',
      url: '/v1/imports/mapper/preview',
      headers,
      payload: { mapping, records: body.records },
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { items: { ref: string; listing: { priceCents: number } }[] }).items[0]).toMatchObject({
      ref: 'A1',
      listing: { priceCents: 10_000_000 },
    });
    const dry = await app.inject({
      method: 'POST',
      url: '/v1/imports/mapper/dry-run',
      headers,
      payload: { mapping, records: body.records },
    });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ total: 3, valid: 3, wouldCreate: 3, comparedWithConnection: false });

    // an invalid mapping is a validation error, a saved one comes back and is listed
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/imports/mapping-profiles',
      headers,
      payload: {
        name: 'Bad',
        mapping: { ...mapping, fields: { ref: { path: '../x' }, propertyType: { path: 'kind' } } },
      },
    });
    expect(invalid.statusCode).toBe(422);
    const saved = await app.inject({
      method: 'POST',
      url: '/v1/imports/mapping-profiles',
      headers,
      payload: { name: 'Items feed', mapping },
    });
    expect(saved.statusCode).toBe(201);
    const profile = saved.json() as { id: string; connector: string };
    expect(profile.connector).toBe('xml-mapped');
    const listed = await app.inject({ method: 'GET', url: '/v1/imports/mapping-profiles', headers });
    expect((listed.json() as { items: { id: string }[] }).items.map((p) => p.id)).toContain(profile.id);
    // another agency neither sees it nor can attach it
    const stranger = await createFounder();
    const theirs = await app.inject({
      method: 'GET',
      url: `/v1/imports/mapping-profiles/${profile.id}`,
      headers: await bearer(stranger.userId, stranger.agencyId),
    });
    expect(theirs.statusCode).toBe(422);
    expect(theirs.json()).toMatchObject({ error: { code: 'FEED_MAPPING_PROFILE_NOT_FOUND' } });

    // a private address is never fetched for a sample
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/imports/mapper/sample-url',
      headers,
      payload: { url: 'http://169.254.169.254/latest/meta-data' },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: { code: 'FEED_URL_NOT_ALLOWED' } });
  });

  it('[S6-05] the CSV / Excel routes: a file is read by its bytes and stored, an import is started with a mapping, binaries and JSON are refused', async () => {
    const owner = await createFounder();
    const headers = await bearer(owner.userId, owner.agencyId);
    const csv = 'Ref;Type;Price;Town\nA1;Villa;250000;Nowhere\nA2;Flat;180000;Nowhere\n';
    for (const type of ['text/csv', 'application/octet-stream']) {
      const sample = await app.inject({
        method: 'POST',
        url: '/v1/imports/sheets',
        headers: { ...headers, 'content-type': type },
        payload: csv,
      });
      expect(sample.statusCode, type).toBe(200);
      expect(sample.json(), type).toMatchObject({
        recordElement: 'row',
        recordCount: 2,
        sheet: { kind: 'csv' },
        suggested: { ref: 'Ref', propertyType: 'Type', price: 'Price' },
      });
    }
    const sample = await app.inject({
      method: 'POST',
      url: '/v1/imports/sheets',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: csv,
    });
    const { sheet } = sample.json() as { sheet: { fileId: string } };

    const png = await app.inject({
      method: 'POST',
      url: '/v1/imports/sheets',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    });
    expect(png.statusCode).toBe(422);
    expect(png.json()).toMatchObject({ error: { code: 'FEED_SAMPLE_INVALID', details: { reason: 'NOT_TEXT' } } });
    const json = await app.inject({
      method: 'POST',
      url: '/v1/imports/sheets',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { a: 1 },
    });
    expect(json.statusCode).toBeGreaterThanOrEqual(400);

    const mapping = {
      schemaVersion: 1,
      recordElement: 'row',
      fields: {
        ref: { path: 'Ref' },
        propertyType: { path: 'Type' },
        price: { path: 'Price' },
        city: { path: 'Town' },
      },
    };
    const started = await app.inject({
      method: 'POST',
      url: '/v1/imports/sheets/import',
      headers,
      payload: { fileId: sheet.fileId, name: 'Spring sheet', mapping },
    });
    expect(started.statusCode).toBe(201);
    const result = started.json() as { connectionId: string; run: { state: string; trigger: string } };
    expect(result.run).toMatchObject({ state: 'QUEUED', trigger: 'MANUAL' });
    const connection = await app.inject({
      method: 'GET',
      url: `/v1/imports/connections/${result.connectionId}`,
      headers,
    });
    expect(connection.json()).toMatchObject({
      connector: 'sheet-mapped',
      url: `upload://${sheet.fileId}`,
      scheduleMinutes: null,
      enabled: true,
    });
    const profiles = await app.inject({
      method: 'GET',
      url: '/v1/imports/mapping-profiles?connector=sheet-mapped',
      headers,
    });
    expect(profiles.json()).toMatchObject({ items: [{ name: 'Spring sheet', connector: 'sheet-mapped' }] });
    // the XML profile list stays free of file profiles
    const xmlProfiles = await app.inject({ method: 'GET', url: '/v1/imports/mapping-profiles', headers });
    expect((xmlProfiles.json() as { items: unknown[] }).items).toEqual([]);
  });
});
