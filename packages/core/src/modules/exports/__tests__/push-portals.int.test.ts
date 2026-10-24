import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CreateListingBody, CreatePortalConnectionBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { invalidateFlags, setFlag, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../../website-api';
import * as exportsModule from '../index';
import { portalFlagKey } from '../profiles';
import { payloadHash, pushPortalListings } from '../push/engine';
import { fotocasaAdapter } from '../push/fotocasa';
import { idealistaAdapter } from '../push/idealista';
import { classifyStatus, PortalPushError } from '../push/types';
import * as repo from '../repo';
import { unregisterExportsSubscriptions } from '../subscriptions';
import {
  configurePortalFeedJobs,
  configurePortalFeeds,
  configurePortalPush,
  exportsJobs,
  generatePortalFeeds,
  registerExportsSubscriptions,
} from '../worker';
import { image, listingDoc } from './portal-fixtures';

/**
 * Push portals (S9-04): idealista and Fotocasa adapters behind their feature flags, driven against a fake partner API
 * (a local HTTP server standing in for the portal's sandbox). Nothing here has run against the real portals (H6).
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('exports.push.test', fn);
const log = createLogger({ service: 'portal-push-test', level: 'silent' });
const MEDIA = 'https://media.example/bucket';
// Characters that must survive the Basic header's form-URL-encoding (RFC 6749 2.3.1).
const CLIENT = { clientId: `client id&${RUN}`, clientSecret: `se+cret/=${RUN}` };
const formEncode = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');

// ── The fake portal ──────────────────────────────────────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  authorization?: string;
  body: unknown;
}
const portal = {
  calls: [] as Call[],
  adverts: new Map<string, unknown>(),
  tokenRequests: 0,
  /** Status to answer a PUT with, by advert code (once per entry unless `sticky`). */
  putStatus: new Map<string, { status: number; retryAfter?: string }>(),
  tokenStatus: 200,
  /** Milliseconds a PUT takes. */
  delayMs: 0,
  /** Status to answer a DELETE with, by advert id. */
  deleteStatus: new Map<string, number>(),
  /** The id the portal answers a PUT with instead of its own. */
  idOverride: null as string | null,
  reset() {
    this.calls = [];
    this.adverts.clear();
    this.tokenRequests = 0;
    this.putStatus.clear();
    this.tokenStatus = 200;
    this.delayMs = 0;
    this.deleteStatus.clear();
    this.idOverride = null;
  },
};
let server: Server;
let origin: string;
let undo: () => void;

async function readBody(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += (chunk as Buffer).toString();
  return text;
}

function handle(req: IncomingMessage, res: ServerResponse, text: string): ServerResponse {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  if (req.url === '/oauth/token') {
    portal.tokenRequests++;
    const basic = `Basic ${Buffer.from(`${formEncode(CLIENT.clientId)}:${formEncode(CLIENT.clientSecret)}`).toString('base64')}`;
    if (portal.tokenStatus !== 200 || req.headers.authorization !== basic)
      return json(401, { error: 'invalid_client' });
    return json(200, { access_token: 'tok-1', token_type: 'bearer', expires_in: 3600 });
  }
  const body: unknown = text ? JSON.parse(text) : null;
  portal.calls.push({
    method: req.method ?? '',
    path: req.url ?? '',
    authorization: req.headers.authorization,
    body,
  });
  if (req.headers.authorization !== 'Bearer tok-1') return json(401, {});
  const key = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
  if (req.method === 'PUT') {
    const planned = portal.putStatus.get(key);
    if (planned) {
      portal.putStatus.delete(key);
      return json(planned.status, {}, planned.retryAfter ? { 'retry-after': planned.retryAfter } : {});
    }
    const id = portal.idOverride ?? (key.startsWith('R-') ? key : `R-${key}`);
    portal.adverts.set(id, body);
    return json(200, { id });
  }
  if (req.method === 'DELETE') {
    const planned = portal.deleteStatus.get(key);
    if (planned) return json(planned, {});
    if (!portal.adverts.delete(key)) return json(404, {});
    return json(204, {});
  }
  return json(405, {});
}

const pushQueued: { payload: Record<string, unknown>; options?: { throttleMs?: number; debounceKey?: string } }[] = [];
const puts = () => portal.calls.filter((c) => c.method === 'PUT');
const deletes = () => portal.calls.filter((c) => c.method === 'DELETE');

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

let a: Founder;
let ids: { propertyType: string; city: string };
let LOCALE = 'es';
const L: Record<string, string> = {};
const REF: Record<string, string> = {};
let connectionId = '';
const IDEALISTA_FLAG = portalFlagKey('idealista');

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function listing(m: Founder, label: string): Promise<void> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.propertyType,
        locationId: ids.city,
        priceCents: 30_000_000,
        energyRating: 'B',
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  L[label] = id;
}

async function readModel(m: Founder, label: string, over: Parameters<typeof listingDoc>[0] = {}): Promise<void> {
  const id = L[label] as string;
  const ref = await system(
    async (tx) =>
      (await tx.execute<{ ref: string }>(sql`select ref from properties where id = ${id}`)).rows[0]?.ref ?? '',
  );
  REF[label] = ref;
  const doc = listingDoc({ id, ref, ...over });
  await system((tx) =>
    tx.execute(sql`
      insert into listing_read_models (target_id, locale, kind, agency_id, public, status, version, card, detail, etag)
      values (${id}, ${LOCALE}, 'LISTING', ${m.agencyId}, true, 'ACTIVE', 1, '{}'::jsonb, ${JSON.stringify(doc)}::jsonb, ${`e-${RUN}-${label}-${newId().slice(-6)}`})
      on conflict (target_id, locale) do update set detail = excluded.detail, etag = excluded.etag, updated_at = now()`),
  );
}

const flagIdealista = async (on: boolean, m: Founder = a) => {
  await system(async (tx) => {
    await setFlag(tx, IDEALISTA_FLAG, { enabled: false });
    await setFlagOverride(tx, IDEALISTA_FLAG, m.agencyId, on ? true : null);
  });
  invalidateFlags();
};

const connect = (channelCode: string, name: string, credentials?: Record<string, string>, m: Founder = a) =>
  as(m, (ctx) =>
    exportsModule.createConnection(ctx, CreatePortalConnectionBody.parse({ channelCode, name, credentials })),
  );

const push = (ids?: string[]) => pushPortalListings(a.agencyId, { connectionIds: ids, log });
const syncRows = (conn: string = connectionId) =>
  system(
    async (tx) =>
      (
        await tx.execute<{ property_id: string; state: string; remote_id: string | null; error_code: string | null }>(
          sql`select property_id, state, remote_id, error_code from portal_listing_sync where connection_id = ${conn} order by property_id`,
        )
      ).rows,
  );
const stateOf = async (label: string) => (await syncRows()).find((r) => r.property_id === L[label]);

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:portal-push:${RUN}` });
  configureStorage(createMemoryStore());
  exportsModule.configureExports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
  });
  configurePortalFeeds({ mediaBaseUrl: MEDIA });
  configurePortalFeedJobs({});
  websiteApi.configureEdgeCache({ tagKey: 'test-edge-tag-key-0123456789abcdef' });
  vi.spyOn(websiteApi.websiteApiJobs.purgeEdgeCache, 'enqueue').mockImplementation(async () => ({ id: newId() }));
  vi.spyOn(exportsJobs.generatePortalFeeds, 'enqueue').mockImplementation(async () => ({ id: newId() }));
  vi.spyOn(exportsJobs.pushPortalListings, 'enqueue').mockImplementation(async (payload, options) => {
    pushQueued.push({ payload: payload as Record<string, unknown>, options });
    return { id: newId() };
  });
  vi.spyOn(exportsJobs.generateNightlyPortalFeeds, 'enqueue').mockImplementation(async () => ({ id: newId() }));

  server = createServer((req, res) => {
    readBody(req)
      .then(async (text) => {
        if (req.method === 'PUT' && portal.delayMs > 0) await new Promise((r) => setTimeout(r, portal.delayMs));
        handle(req, res, text);
      })
      .catch(() => res.writeHead(400).end());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  undo = allowLoopbackOriginsForTests([origin]);
  configurePortalPush({
    endpoints: {
      idealista: {
        apiBase: `${origin}/v1/properties`.replace('/v1/properties', ''),
        tokenUrl: `${origin}/oauth/token`,
      },
    },
  });

  await system((tx) => exportsModule.syncPortalChannels(tx));
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  LOCALE = (await system((tx) => agencies.readModelOwnersOf(tx, [a.agencyId]))).get(a.agencyId)?.locales[0] ?? 'es';
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('px'),
      translations: name('Pushland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('px-r'),
      translations: name('Pushcoast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('px-c'),
      translations: name('Pushcity'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('px-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const propertyType = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('px-t'),
      sort: 0,
      translations: name('Villa'),
    });
    return { propertyType, city };
  });
  for (const label of ['one', 'two', 'three']) {
    await listing(a, label);
    await readModel(a, label);
  }
}, 180_000);

beforeEach(() => {
  portal.reset();
  pushQueued.length = 0;
});

afterAll(async () => {
  undo();
  server.close();
  vi.restoreAllMocks();
  await closeCache();
  await closeDb();
});

describe('[S9-04] flags and setup', () => {
  it('[S9-04] a push portal is PLANNED until its flag is on for the agency; then it can be connected', async () => {
    const planned = async () =>
      (await as(a, (ctx) => exportsModule.listChannels(ctx))).items.find((c) => c.code === 'idealista')?.status;
    await flagIdealista(false);
    expect(await planned()).toBe('PLANNED');
    await expect(connect('idealista', 'idealista off', CLIENT)).rejects.toMatchObject({
      code: 'PORTAL_CHANNEL_UNAVAILABLE',
    });
    await flagIdealista(true);
    expect(await planned()).toBe('AVAILABLE');
    const created = await connect('idealista', 'idealista main', CLIENT);
    connectionId = created.connection.id;
    expect(created.connection.credentialKeys).toEqual(['clientId', 'clientSecret']);
    // Fotocasa has no flag on: still not connectable.
    await expect(connect('fotocasa', 'fotocasa', CLIENT)).rejects.toMatchObject({ code: 'PORTAL_CHANNEL_UNAVAILABLE' });
  });

  it('[S9-04] the feed pass leaves a push connection to the push job: no feed file, no feed run', async () => {
    const result = await generatePortalFeeds(a.agencyId, { trigger: 'EVENT', log });
    expect(result.push).toEqual([connectionId]);
    expect(result.written).toEqual([]);
    expect(result.skippedConnections).toEqual([]);
    const runs = await as(a, (ctx) => exportsModule.listFeedRuns(ctx, { connectionId }));
    expect(runs.items).toEqual([]);
  });
});

describe('[S9-04] pushing against the fake portal', () => {
  it('[S9-04] publishes every valid listing once, with one token, the listing reference as key, and records the portal id', async () => {
    const result = await push();
    expect(result.connections).toMatchObject([{ published: 3, updated: 0, withdrawn: 0, failed: 0, invalid: 0 }]);
    expect(portal.tokenRequests).toBe(1);
    expect(puts()).toHaveLength(3);
    expect(puts().every((c) => c.authorization === 'Bearer tok-1')).toBe(true);
    expect(
      puts()
        .map((c) => decodeURIComponent(c.path.split('/').pop() as string))
        .sort(),
    ).toEqual(Object.values(REF).sort());
    const rows = await syncRows();
    expect(rows.map((r) => r.state)).toEqual(['SYNCED', 'SYNCED', 'SYNCED']);
    expect(rows.every((r) => r.remote_id?.startsWith('R-'))).toBe(true);
    // The payload carries the client-safe facts only.
    const payload = JSON.stringify(puts()[0]?.body);
    expect(payload).toContain('propertyCode');
    expect(payload).not.toMatch(/commission|owner|internal|clientSecret/i);
    expect(JSON.stringify(portal.calls)).not.toContain(CLIENT.clientSecret);
    // The summary on the connection.
    const dto = await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId }));
    expect(dto.validation).toMatchObject({ validCount: 3, invalidCount: 0 });
  });

  it('[S9-04] a second run with nothing changed makes no listing call', async () => {
    const result = await push();
    expect(result.connections).toMatchObject([{ published: 0, updated: 0, withdrawn: 0, unchanged: 3 }]);
    expect(puts()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it('[S9-04] a changed listing is updated through the portal id; the others stay', async () => {
    await readModel(a, 'two', { price: { amountCents: 99_000_000, currency: 'EUR', period: null, onRequest: false } });
    const result = await push();
    expect(result.connections).toMatchObject([{ published: 0, updated: 1, unchanged: 2 }]);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.path).toBe(`/v1/properties/R-${encodeURIComponent(REF.two as string)}`);
    expect(JSON.stringify(puts()[0]?.body)).toContain('990000');
  });

  it('[S9-04] a listing that leaves the selection is withdrawn; selected again, it is published again', async () => {
    await as(a, (ctx) =>
      exportsModule.setOverrides(
        ctx,
        { connectionId },
        { items: [{ propertyId: L.three as string, action: 'EXCLUDE' }] },
      ),
    );
    const out = await push();
    expect(out.connections).toMatchObject([{ withdrawn: 1, unchanged: 2 }]);
    expect(deletes().map((c) => c.path)).toEqual([`/v1/properties/R-${encodeURIComponent(REF.three as string)}`]);
    expect((await stateOf('three'))?.state).toBe('WITHDRAWN');
    expect(portal.adverts.has(`R-${REF.three}`)).toBe(false);

    portal.reset();
    await as(a, (ctx) =>
      exportsModule.setOverrides(ctx, { connectionId }, { items: [{ propertyId: L.three as string, action: null }] }),
    );
    const back = await push();
    expect(back.connections).toMatchObject([{ updated: 1, unchanged: 2 }]);
    expect((await stateOf('three'))?.state).toBe('SYNCED');
  });

  it('[S9-04] a listing failing the portal profile is not sent, its reasons are stored and a synced advert stays', async () => {
    await listing(a, 'thin');
    await readModel(a, 'thin', { media: [image(1)], imageCount: 1 });
    const out = await push();
    expect(out.connections).toMatchObject([{ published: 0, invalid: 1, unchanged: 3 }]);
    expect(puts()).toHaveLength(0);
    const issues = await as(a, (ctx) => exportsModule.listIssues(ctx, { connectionId }, {} as never));
    expect(issues.items.map((i) => i.issues.map((x) => x.code))).toEqual([['PHOTOS_TOO_FEW']]);
    expect(await stateOf('thin')).toBeUndefined();
    // Photos added: it goes out.
    await readModel(a, 'thin');
    expect((await push()).connections).toMatchObject([{ published: 1, invalid: 0 }]);
  });

  it('[S9-04] a permanent refusal marks the listing FAILED and is not retried until its content changes', async () => {
    await readModel(a, 'one', { bedrooms: 7 });
    portal.putStatus.set(`R-${REF.one}`, { status: 422 });
    const first = await push();
    expect(first.connections).toMatchObject([{ failed: 1, updated: 0 }]);
    expect(await stateOf('one')).toMatchObject({ state: 'FAILED', error_code: 'REJECTED' });
    portal.reset();
    const again = await push();
    expect(again.connections).toMatchObject([{ failed: 1 }]);
    expect(puts()).toHaveLength(0);
    // Changed content is tried again.
    await readModel(a, 'one', { bedrooms: 8 });
    const changed = await push();
    expect(changed.connections).toMatchObject([{ updated: 1, failed: 0 }]);
    expect((await stateOf('one'))?.state).toBe('SYNCED');
  });

  it('[S9-04] a rate limit without Retry-After stops the connection with a retryable error; what was sent is kept and the retry sends the rest', async () => {
    for (const label of ['one', 'two', 'three']) {
      await readModel(a, label, { bathrooms: 5 + label.length });
    }
    // The second advert in id order is the one the portal refuses with 429.
    const order = [...Object.entries(L)]
      .filter(([k]) => ['one', 'two', 'three'].includes(k))
      .sort((x, y) => (x[1] < y[1] ? -1 : 1));
    const limited = REF[order[1]?.[0] as string] as string;
    portal.putStatus.set(`R-${limited}`, { status: 429 });
    const error = await push().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalPushError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, scope: 'CONNECTION' });
    expect(puts()).toHaveLength(2);
    portal.calls = [];
    const retry = await push();
    // Only the two that did not go through are sent again (the first and the earlier extra listing stay).
    expect(retry.connections).toMatchObject([{ updated: 2, unchanged: 2 }]);
    expect(puts()).toHaveLength(2);
  });

  it('[S9-04] rejected credentials are stored on the connection and skipped (no token call) until they change or the nightly run looks again', async () => {
    await readModel(a, 'one', { bathrooms: 1 });
    portal.tokenStatus = 401;
    const out = await push();
    expect(out.connections).toMatchObject([{ stopped: 'AUTH_REJECTED', published: 0, updated: 0 }]);
    expect(puts()).toHaveLength(0);
    expect((await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId }))).pushError).toBe('AUTH_REJECTED');
    // Fixed at the portal, but nothing changed here: the event-driven run does not even ask for a token.
    portal.tokenStatus = 200;
    portal.tokenRequests = 0;
    expect((await push()).connections).toMatchObject([{ stopped: 'AUTH_REJECTED' }]);
    expect(portal.tokenRequests).toBe(0);
    // The nightly run looks again and clears the stop.
    const nightly = await pushPortalListings(a.agencyId, { connectionIds: [connectionId], retryStopped: true, log });
    expect(nightly.connections).toMatchObject([{ updated: 1 }]);
    expect((await as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId }))).pushError).toBeNull();
  });

  it('[S9-04] a connection without credentials, or a portal without endpoints, stops with a code and calls nothing', async () => {
    const bare = await connect('idealista', 'idealista bare');
    const only = await push([bare.connection.id]);
    expect(only.connections).toMatchObject([{ stopped: 'CREDENTIALS_MISSING' }]);
    expect(portal.calls).toHaveLength(0);
    configurePortalPush({ endpoints: {} });
    try {
      expect((await push([connectionId])).connections).toMatchObject([{ stopped: 'NOT_CONFIGURED' }]);
    } finally {
      configurePortalPush({ endpoints: { idealista: { apiBase: origin, tokenUrl: `${origin}/oauth/token` } } });
    }
    await as(a, (ctx) => exportsModule.deleteConnection(ctx, { connectionId: bare.connection.id }));
  });

  it('[S9-04] with the flag off the connection is taken down while its credentials are readable; the flag back on puts the adverts up again', async () => {
    await readModel(a, 'two', { bathrooms: 9 });
    await flagIdealista(false);
    try {
      const feed = await generatePortalFeeds(a.agencyId, { trigger: 'EVENT', log });
      // The feed pass still hands the connection to the push job, which decides.
      expect(feed.push).toEqual([connectionId]);
      expect(feed.skippedConnections).toEqual([]);
      const out = await push();
      expect(out.connections).toMatchObject([{ mode: 'TEARDOWN', published: 0, updated: 0, withdrawn: 4 }]);
      expect(puts()).toHaveLength(0);
      expect(portal.adverts.size).toBe(0);
      expect((await syncRows()).map((r) => r.state)).toEqual(['WITHDRAWN', 'WITHDRAWN', 'WITHDRAWN', 'WITHDRAWN']);
      portal.calls = [];
      // Nothing left to take down: no more calls.
      expect((await push()).connections).toMatchObject([{ mode: 'TEARDOWN', withdrawn: 0 }]);
      expect(portal.calls).toHaveLength(0);
    } finally {
      await flagIdealista(true);
    }
    const back = await push();
    expect(back.connections).toMatchObject([{ mode: 'SYNC', updated: 4 }]);
    expect(portal.adverts.size).toBe(4);
  });

  it('[S9-04] an advert the portal lost is published again; a withdrawal of an advert it no longer has succeeds', async () => {
    portal.adverts.clear();
    await readModel(a, 'one', { bathrooms: 2 });
    // The update 404s (the portal lost the advert), so the engine creates it again.
    portal.putStatus.set(`R-${REF.one}`, { status: 404 });
    expect((await push()).connections).toMatchObject([{ updated: 1, failed: 0 }]);
    expect(puts()).toHaveLength(2);
    expect(portal.adverts.size).toBe(1);
    portal.adverts.clear();
    await as(a, (ctx) =>
      exportsModule.setOverrides(
        ctx,
        { connectionId },
        { items: [{ propertyId: L.two as string, action: 'EXCLUDE' }] },
      ),
    );
    expect((await push()).connections).toMatchObject([{ withdrawn: 1 }]);
    expect((await stateOf('two'))?.state).toBe('WITHDRAWN');
  });
});

describe('[S9-04] adapters', () => {
  const item = async (over: Parameters<typeof listingDoc>[0] = {}) => {
    const owners = await system((tx) => agencies.readModelOwnersOf(tx, [a.agencyId]));
    expect(owners.size).toBe(1);
    const { buildItems } = await import('../feed');
    const doc = listingDoc({ id: L.one as string, ref: REF.one as string, ...over });
    const built = buildItems(
      [L.one as string],
      [{ targetId: L.one as string, locale: LOCALE, doc, updatedAt: new Date('2026-01-01T00:00:00Z') } as never],
      {
        locales: [LOCALE],
        baseLocale: LOCALE,
        mediaBase: MEDIA,
        presenter: {
          name: 'Agency',
          email: null,
          phone: null,
          whatsapp: null,
          website: null,
          primaryColor: null,
          accentColor: null,
        },
      },
    );
    return built.items[0]?.item as NonNullable<(typeof built.items)[0]>['item'];
  };

  it('[S9-04] mapping is pure and stable (same listing, same hash) and carries no private data', async () => {
    const it1 = await item();
    for (const adapter of [idealistaAdapter, fotocasaAdapter]) {
      const p1 = adapter.mapListing(it1, LOCALE);
      expect(payloadHash(p1)).toBe(payloadHash(adapter.mapListing(it1, LOCALE)));
      const text = JSON.stringify(p1);
      expect(text).toContain(REF.one as string);
      expect(text).toContain(`${MEDIA}/v1/img1/large.webp`);
      expect(text).not.toMatch(/owner|commission|internalNotes|agency/i);
    }
    expect(fotocasaAdapter.credentials.required).toEqual(['clientId', 'clientSecret']);
  });

  it('[S9-04] an EXACT pin is rounded to about 110 m before it leaves; an APPROX one is sent as it is', async () => {
    const exact = await item({ geo: { lat: 36.123456, lng: -4.987654, precision: 'EXACT' } });
    const approx = await item({ geo: { lat: 36.12, lng: -4.98, precision: 'APPROX' } });
    for (const adapter of [idealistaAdapter, fotocasaAdapter]) {
      const text = JSON.stringify(adapter.mapListing(exact, LOCALE));
      expect(text).toContain('36.123');
      expect(text).toContain('-4.988');
      expect(text).not.toMatch(/36\.1234|4\.9876/);
      expect(JSON.stringify(adapter.mapListing(approx, LOCALE))).toContain('36.12');
    }
  });

  it('[S9-04] statuses are classified: 4xx permanent per listing, auth and 5xx/429 per connection, 404 gone', () => {
    expect(classifyStatus(200)).toBeNull();
    expect(classifyStatus(204)).toBeNull();
    expect(classifyStatus(422)).toMatchObject({ code: 'REJECTED', retryable: false, scope: 'LISTING' });
    expect(classifyStatus(404)).toMatchObject({ code: 'NOT_FOUND', retryable: false, scope: 'LISTING' });
    expect(classifyStatus(401)).toMatchObject({ code: 'AUTH_REJECTED', retryable: false, scope: 'CONNECTION' });
    expect(classifyStatus(403)).toMatchObject({ code: 'AUTH_REJECTED', retryable: false, scope: 'CONNECTION' });
    expect(classifyStatus(429, 5000)).toMatchObject({ retryable: true, scope: 'CONNECTION', retryAfterMs: 5000 });
    expect(classifyStatus(503)).toMatchObject({ code: 'PORTAL_ERROR', retryable: true, scope: 'CONNECTION' });
    // A redirect from a partner API is a wrong base URL: permanent, for the connection.
    expect(classifyStatus(302)).toMatchObject({ code: 'NOT_CONFIGURED', retryable: false, scope: 'CONNECTION' });
  });
});

// ── Review fixes: teardown, budgets, resume, standing stops ──────────────────────────────────────────────────────────

describe('[S9-04] teardown, budgets and resuming (a second agency, one connection)', () => {
  let b: Founder;
  let cb = '';
  const configure = (over: Partial<Parameters<typeof configurePortalPush>[0]> = {}) =>
    configurePortalPush({
      ...over,
      endpoints: { idealista: { apiBase: origin, tokenUrl: `${origin}/oauth/token` } },
    });
  const pushB = (opts: Parameters<typeof pushPortalListings>[1] = {}) =>
    pushPortalListings(b.agencyId, { connectionIds: [cb], log, ...opts });
  const rowsB = () => syncRows(cb);
  const stateB = async (label: string) => (await rowsB()).find((r) => r.property_id === L[label]);
  const asB = <T>(fn: (ctx: Ctx) => Promise<T>) => as(b, fn);
  const dtoB = () => asB((ctx) => exportsModule.getConnection(ctx, { connectionId: cb }));
  const jobCtx = () => ({
    log,
    jobId: newId(),
    attempt: 1,
    progress: async () => {},
    signal: new AbortController().signal,
  });
  const clearRows = () => system((tx) => tx.execute(sql`delete from portal_listing_sync where connection_id = ${cb}`));
  const override = (label: string, action: 'EXCLUDE' | 'INCLUDE' | null) =>
    asB((ctx) =>
      exportsModule.setOverrides(ctx, { connectionId: cb }, { items: [{ propertyId: L[label] as string, action }] }),
    );

  beforeAll(async () => {
    b = await createFounder();
    await setAgencyStatus(b.agencyId, 'VERIFIED');
    await flagIdealista(true, b);
    for (const label of ['b1', 'b2', 'b3', 'b4']) {
      await listing(b, label);
      await readModel(b, label);
    }
    cb = (await connect('idealista', 'b main', CLIENT, b)).connection.id;
    configure();
  }, 120_000);

  afterAll(() => {
    configure();
    vi.restoreAllMocks();
  });

  it('[S9-04] an advert in FAILED state is withdrawn when its listing is deselected', async () => {
    expect((await pushB()).connections).toMatchObject([{ published: 4 }]);
    await readModel(b, 'b1', { bedrooms: 11 });
    portal.putStatus.set(`R-${REF.b1}`, { status: 422 });
    expect((await pushB()).connections).toMatchObject([{ failed: 1 }]);
    expect(await stateB('b1')).toMatchObject({ state: 'FAILED', remote_id: `R-${REF.b1}` });
    await override('b1', 'EXCLUDE');
    portal.calls = [];
    expect((await pushB()).connections).toMatchObject([{ withdrawn: 1 }]);
    expect(deletes().map((c) => c.path)).toEqual([`/v1/properties/R-${encodeURIComponent(REF.b1 as string)}`]);
    expect((await stateB('b1'))?.state).toBe('WITHDRAWN');
  });

  it('[S9-04] the time budget is one per run: a second connection does not start after the first used it up', async () => {
    const second = (await connect('idealista', 'b second', CLIENT, b)).connection.id;
    try {
      for (const label of ['b2', 'b3', 'b4']) await readModel(b, label, { bathrooms: 7 });
      configure({ runBudgetMs: 1500 });
      portal.delayMs = 1800;
      const out = await pushPortalListings(b.agencyId, { log });
      // The first PUT takes 1.8 s: the run's deadline has passed before its second call and before the other connection.
      expect(puts()).toHaveLength(1);
      expect(out.connections).toHaveLength(2);
      expect(out.connections.every((c) => c.more === true)).toBe(true);
      expect(out.connections.filter((c) => c.published + c.updated === 0)).toHaveLength(1);
    } finally {
      configure();
      portal.delayMs = 0;
    }
    // Finish the first connection's work; the second one has nothing up, so it can be deleted.
    await pushB();
    await system((tx) => tx.execute(sql`delete from portal_listing_sync where connection_id = ${second}`));
    await asB((ctx) => exportsModule.deleteConnection(ctx, { connectionId: second }));
  });

  it('[S9-04] calls past the per-run limit continue from the selection round through a queued continuation', async () => {
    await override('b1', null);
    await clearRows();
    configure({ maxCallsPerRun: 2, batchSize: 2 });
    try {
      const first = await exportsJobs.pushPortalListings.spec.run(
        { agencyId: b.agencyId, connectionId: cb },
        jobCtx() as never,
      );
      expect(first).toMatchObject({ published: 2, more: 1 });
      const firstPaths = puts().map((c) => c.path);
      const queued = pushQueued.at(-1);
      expect(queued?.payload).toMatchObject({ agencyId: b.agencyId, connectionId: cb });
      expect(queued?.payload.cursor).toMatch(/^[0-9a-f-]{36}$/);
      expect(queued?.options).toMatchObject({ debounceKey: `portal-push-more:${cb}`, throttleMs: 60_000 });
      portal.calls = [];
      const second = await exportsJobs.pushPortalListings.spec.run(queued?.payload as never, jobCtx() as never);
      expect(second).toMatchObject({ published: 2, more: 0 });
      expect(new Set([...firstPaths, ...puts().map((c) => c.path)]).size).toBe(4);
      expect((await rowsB()).map((r) => r.state)).toEqual(['SYNCED', 'SYNCED', 'SYNCED', 'SYNCED']);
    } finally {
      configure();
    }
  });

  it('[S9-04] the results of the calls made are saved even when a later step throws something unexpected', async () => {
    await clearRows();
    const original = idealistaAdapter.publish.bind(idealistaAdapter);
    let n = 0;
    const spy = vi.spyOn(idealistaAdapter, 'publish').mockImplementation(async (...args) => {
      n++;
      if (n === 2) throw new Error('boom');
      return original(...args);
    });
    try {
      await expect(pushB()).rejects.toThrow('boom');
    } finally {
      spy.mockRestore();
    }
    expect((await rowsB()).map((r) => r.state)).toEqual(['SYNCED']);
    portal.calls = [];
    // The retry sends only the other three.
    expect((await pushB()).connections).toMatchObject([{ published: 3, unchanged: 1 }]);
  });

  it('[S9-04] Retry-After makes a continuation after that wait, not a failed job', async () => {
    await readModel(b, 'b2', { bathrooms: 3 });
    portal.putStatus.set(`R-${REF.b2}`, { status: 429, retryAfter: '120' });
    const result = await exportsJobs.pushPortalListings.spec.run(
      { agencyId: b.agencyId, connectionId: cb },
      jobCtx() as never,
    );
    expect(result).toMatchObject({ more: 1, updated: 0 });
    const queued = pushQueued.at(-1);
    expect(queued?.payload).toMatchObject({ agencyId: b.agencyId, connectionId: cb });
    expect(queued?.options).toMatchObject({ throttleMs: 120_000, debounceKey: `portal-push-more:${cb}` });
    expect((await pushB()).connections).toMatchObject([{ updated: 1 }]);
  });

  it('[S9-04] a refused withdrawal is remembered with the advert id, not asked again, and the listing goes up again when wanted', async () => {
    await override('b3', 'EXCLUDE');
    portal.deleteStatus.set(`R-${REF.b3}`, 422);
    const first = await pushB();
    expect(first.connections).toMatchObject([{ withdrawn: 0, failed: 1, withdrawFailed: 1 }]);
    expect(await stateB('b3')).toMatchObject({
      state: 'FAILED',
      error_code: 'WITHDRAW_REJECTED',
      remote_id: `R-${REF.b3}`,
    });
    portal.calls = [];
    const again = await pushB();
    expect(again.connections[0]?.more).toBeUndefined();
    expect(deletes()).toHaveLength(0);
    // Wanted again: the advert is still up, so it is updated and the row is SYNCED.
    await override('b3', null);
    expect((await pushB()).connections).toMatchObject([{ updated: 1 }]);
    expect((await stateB('b3'))?.state).toBe('SYNCED');
  });

  it('[S9-04] [S10-F4] a 404 on creating an advert means a wrong base URL: stored on the connection and skipped until the credentials change (the trigger clears it)', async () => {
    await system((tx) =>
      tx.execute(sql`delete from portal_listing_sync where connection_id = ${cb} and property_id = ${L.b4}`),
    );
    portal.putStatus.set(REF.b4 as string, { status: 404 });
    const stopped = await pushB();
    expect(stopped.connections).toMatchObject([{ stopped: 'NOT_CONFIGURED', published: 0 }]);
    expect((await dtoB()).pushError).toBe('NOT_CONFIGURED');
    portal.calls = [];
    expect((await pushB()).connections).toMatchObject([{ stopped: 'NOT_CONFIGURED' }]);
    expect(portal.calls).toHaveLength(0);
    const dto = await dtoB();
    const updated = await asB((ctx) =>
      exportsModule.updateConnection(ctx, { connectionId: cb }, { version: dto.version, credentials: CLIENT }),
    );
    expect(updated.pushError).toBeNull();
    expect((await pushB()).connections).toMatchObject([{ published: 1 }]);
  });

  it('[S9-04] a remote id that is not a plain token is not stored: our own key is', async () => {
    await system((tx) =>
      tx.execute(sql`delete from portal_listing_sync where connection_id = ${cb} and property_id = ${L.b4}`),
    );
    portal.idOverride = '../evil/../id';
    await pushB();
    portal.idOverride = null;
    expect((await stateB('b4'))?.remote_id).toBe(REF.b4);
  });

  it('[S9-04] the feed pass queues the push job (events and nightly); the nightly pass marks the connection and retries standing stops', async () => {
    await exportsJobs.generatePortalFeeds.spec.run({ agencyId: b.agencyId }, jobCtx() as never);
    expect(pushQueued.at(-1)).toMatchObject({
      payload: { agencyId: b.agencyId },
      options: { debounceKey: `portal-push:${b.agencyId}` },
    });
    expect(pushQueued.at(-1)?.payload.retry).toBeUndefined();
    await exportsJobs.generateNightlyPortalFeeds.spec.run(
      { agencyId: b.agencyId, nightly: '2026-10-23', lane: 0, lanes: 6 },
      jobCtx(),
    );
    expect(pushQueued.at(-1)?.payload).toMatchObject({ agencyId: b.agencyId, retry: true });
    const nightlyAt = await system(
      async (tx) =>
        (
          await tx.execute<{ nightly_at: Date | null }>(
            sql`select nightly_at from agency_portal_connections where id = ${cb}`,
          )
        ).rows[0]?.nightly_at,
    );
    expect(nightlyAt).not.toBeNull();
  });

  it("[S9-04] a suspended agency's adverts come down while the credentials are readable; verified again, they go up", async () => {
    registerExportsSubscriptions();
    try {
      await setAgencyStatus(b.agencyId, 'SUSPENDED');
      for (const sub of defaultSubscribers.get('agencies.status.changed', 1)) {
        if (!sub.name.startsWith('exports.feed.')) continue;
        await sub.handler({ agencyId: b.agencyId, from: 'VERIFIED', to: 'SUSPENDED', version: 2 } as never, {
          eventId: newId(),
          agencyId: b.agencyId,
          type: 'agencies.status.changed',
          version: 1,
          createdAt: new Date(),
          attempt: 1,
        });
      }
      expect(pushQueued.at(-1)).toMatchObject({ payload: { agencyId: b.agencyId } });
      portal.calls = [];
      const down = await pushB();
      expect(down.connections).toMatchObject([{ mode: 'TEARDOWN', withdrawn: 4, published: 0, updated: 0 }]);
      expect(portal.adverts.size).toBe(0);
      await setAgencyStatus(b.agencyId, 'VERIFIED');
      expect((await pushB()).connections).toMatchObject([{ mode: 'SYNC', updated: 4 }]);
      expect(portal.adverts.size).toBe(4);
    } finally {
      unregisterExportsSubscriptions();
      await setAgencyStatus(b.agencyId, 'VERIFIED');
    }
  });

  it('[S10-F8] live adverts are read by listing-id keyset: every advert once, no page read again', async () => {
    const pages: string[][] = [];
    let after: string | null = null;
    for (;;) {
      const from = after;
      const page: repo.SyncRow[] = await system((tx) =>
        repo.liveAdverts(tx, b.agencyId, cb, { after: from, limit: 3 }),
      );
      pages.push(page.map((r) => r.propertyId));
      if (page.length < 3) break;
      after = page.at(-1)?.propertyId ?? null;
    }
    const seen = pages.flat();
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen).toEqual([...seen].sort());
    expect(pages.map((p) => p.length)).toEqual([3, 1]);
    expect(await system((tx) => repo.hasLiveAdverts(tx, b.agencyId, cb))).toBe(true);
  });

  it('[S9-04] a connection with adverts up cannot be deleted; switched off, its adverts are withdrawn and then it can', async () => {
    await expect(asB((ctx) => exportsModule.deleteConnection(ctx, { connectionId: cb }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const dto = await dtoB();
    await asB((ctx) =>
      exportsModule.updateConnection(ctx, { connectionId: cb }, { version: dto.version, enabled: false }),
    );
    // The change queues a named feed pass, which hands the (now disabled) connection to the push job.
    const feed = await generatePortalFeeds(b.agencyId, { connectionIds: [cb], trigger: 'EVENT', log });
    expect(feed.push).toEqual([cb]);
    expect(feed.skippedConnections).toEqual([]);
    portal.calls = [];
    let down: Awaited<ReturnType<typeof pushB>> | undefined;
    // S10-F8: the teardown reads the adverts once — a short keyset page is the last, nothing is read again.
    const reads = await countQueries(
      async () => {
        down = await pushB();
      },
      { match: /"error_code" is distinct from/ },
    );
    expect(down?.connections).toMatchObject([{ mode: 'TEARDOWN', withdrawn: 4 }]);
    expect(reads).toBe(1);
    expect(portal.adverts.size).toBe(0);
    await asB((ctx) => exportsModule.deleteConnection(ctx, { connectionId: cb }));
    expect(
      await system(
        async (tx) => (await tx.execute(sql`select 1 from agency_portal_connections where id = ${cb}`)).rows,
      ),
    ).toEqual([]);
  });
});
