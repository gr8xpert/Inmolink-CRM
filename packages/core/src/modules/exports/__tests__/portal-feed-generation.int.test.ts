import { gunzipSync } from 'node:zlib';
import { CreateListingBody, CreatePortalConnectionBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { invalidateFlags, setFlag, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { configureStorage, createMemoryStore, type ObjectStore } from '@inmolink/platform/storage';
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
import {
  configurePortalFeedJobs,
  configurePortalFeeds,
  exportsJobs,
  generatePortalFeeds,
  nightlyWindow,
  PORTAL_FEED_CONNECTION_THROTTLE_MS,
  PORTAL_FEED_SOON_MS,
  PORTAL_FEED_THROTTLE_MS,
  registerExportsSubscriptions,
  resetLiveConnectionCache,
  seedNightlyLanes,
  unregisterExportsSubscriptions,
  writeConnectionFeed,
} from '../worker';
import { DESCRIPTION, listingDoc, schemaErrors, xsd } from './portal-fixtures';

/**
 * Portal feed generation and delivery (S9-03): one pass per agency writes every live connection's file to object
 * storage (the platform memory store, wrapped to count completed and aborted uploads), an unchanged feed is not
 * rewritten (content hash), each run is recorded (bounded history), feed-api serves the file at its token URL, and
 * listing, selection and connection changes queue throttled runs.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('exports.generation.test', fn);
const MEDIA = 'https://media.example/bucket';
const log = createLogger({ service: 'portal-feed-test', level: 'silent' });

let a: Founder;
let ids: { propertyType: string; city: string };
const L: Record<string, string> = {};
const REF: Record<string, string> = {};
let LOCALE = 'es';
const C = { kyero: '', generic: '' };
const TOKEN = { kyero: '' };

const memory = createMemoryStore();
const uploads = { completed: 0, aborted: 0 };
/** The memory store, counting completed and aborted uploads (a rewrite completes one). */
const store: ObjectStore = {
  ...memory,
  upload(bucket, key, options) {
    const u = memory.upload(bucket, key, options);
    return {
      write: (chunk) => u.write(chunk),
      complete: async () => {
        uploads.completed++;
        return u.complete();
      },
      abort: async () => {
        uploads.aborted++;
        return u.abort();
      },
    };
  },
};

const purges: string[] = [];
const enqueues: { payload: Record<string, unknown>; throttleMs?: number; debounceKey?: string }[] = [];

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function listing(m: Founder, label: string): Promise<string> {
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
  return id;
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
      values (${id}, ${LOCALE}, 'LISTING', ${m.agencyId}, true, 'ACTIVE', 1, '{}'::jsonb, ${JSON.stringify(doc)}::jsonb, ${`e-${RUN}-${label}`})
      on conflict (target_id, locale) do update set detail = excluded.detail, updated_at = now()`),
  );
}

async function connect(m: Founder, channelCode: string, name: string) {
  const body = CreatePortalConnectionBody.parse({ channelCode, name });
  return as(m, (ctx) => exportsModule.createConnection(ctx, body));
}

const generate = (connectionIds?: string[], trigger: 'EVENT' | 'NIGHTLY' = 'EVENT') =>
  generatePortalFeeds(a.agencyId, { connectionIds, trigger, log });

const dto = (connectionId: string) => as(a, (ctx) => exportsModule.getConnection(ctx, { connectionId }));
const runs = (connectionId: string) => as(a, (ctx) => exportsModule.listFeedRuns(ctx, { connectionId }));
const currentRunId = (connectionId: string) =>
  system(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(
          sql`select feed_run_id as id from agency_portal_connections where id = ${connectionId}`,
        )
      ).rows[0]?.id,
  );

/** The connection's stored objects (keys under its prefix). */
const objectsOf = (connectionId: string) =>
  [...memory.objects.keys()].filter((k) => k.startsWith(`feeds/${exportsModule.portalFeedPrefix(connectionId)}`));

async function served(token: string, file: 'kyero.xml' | 'inmolink.xml') {
  const f = await exportsModule.portalFeedFile(token, file);
  const xml = gunzipSync(Buffer.concat(await (await f.open()).toArray())).toString('utf8');
  return { file: f, xml };
}

/** Runs an event's portal feed subscribers as the dispatcher would. */
async function publish(type: string, payload: unknown, agencyId: string): Promise<void> {
  for (const sub of defaultSubscribers.get(type, 1)) {
    if (!sub.name.startsWith('exports.feed.')) continue;
    await sub.handler(payload as never, {
      eventId: newId(),
      agencyId,
      type,
      version: 1,
      createdAt: new Date(),
      attempt: 1,
    });
  }
}

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:portal-feeds:${RUN}` });
  configureStorage(store);
  exportsModule.configureExports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
  });
  configurePortalFeeds({ mediaBaseUrl: MEDIA });
  websiteApi.configureEdgeCache({ tagKey: 'test-edge-tag-key-0123456789abcdef' });
  vi.spyOn(websiteApi.websiteApiJobs.purgeEdgeCache, 'enqueue').mockImplementation(async (payload) => {
    purges.push((payload as { agencyId: string }).agencyId);
    return { id: newId() };
  });
  const record = (payload: unknown, options?: { throttleMs?: number; debounceKey?: string }) =>
    enqueues.push({
      payload: payload as Record<string, unknown>,
      throttleMs: options?.throttleMs,
      debounceKey: options?.debounceKey,
    });
  vi.spyOn(exportsJobs.generatePortalFeeds, 'enqueue').mockImplementation(async (payload, options) => {
    record(payload, options);
    return { id: newId() };
  });
  vi.spyOn(exportsJobs.generateNightlyPortalFeeds, 'enqueueMany').mockImplementation(async (entries) => {
    for (const e of entries) record(e.payload, e.options);
    return entries.map(() => ({ id: newId() }));
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
      code: code('gx'),
      translations: name('Genland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('gx-r'),
      translations: name('Gencoast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('gx-c'),
      translations: name('Gencity'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('gx-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const propertyType = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('gx-t'),
      sort: 0,
      translations: name('Villa'),
    });
    return { propertyType, city };
  });
  for (const label of ['one', 'two', 'three']) {
    await listing(a, label);
    await readModel(a, label);
  }
  const kyero = await connect(a, 'kyero', 'Kyero main');
  C.kyero = kyero.connection.id;
  TOKEN.kyero = kyero.token;
}, 180_000);

beforeEach(() => {
  enqueues.length = 0;
  purges.length = 0;
});

afterAll(async () => {
  unregisterExportsSubscriptions();
  vi.restoreAllMocks();
  await closeCache();
  await closeDb();
});

describe('[S9-03] content hash: an unchanged feed is not rewritten', () => {
  it('[S9-03] unchanged feeds are not rewritten: same content hash → the upload is aborted and the served object stays', async () => {
    const first = await generate([C.kyero]);
    expect(first.written).toEqual([C.kyero]);
    const feed1 = (await dto(C.kyero)).feed;
    expect(feed1).toMatchObject({ file: 'kyero.xml', itemCount: 3 });
    const [key] = objectsOf(C.kyero);
    expect(objectsOf(C.kyero)).toHaveLength(1);
    const stamp = memory.objects.get(key as string)?.lastModified;
    const before = { ...uploads };
    purges.length = 0;

    const second = await generate([C.kyero]);
    expect(second).toMatchObject({ written: [], unchanged: [C.kyero], failed: [] });
    // Nothing completed: the upload of the identical bytes was aborted; the object and its pointer are the same.
    expect(uploads.completed).toBe(before.completed);
    expect(uploads.aborted).toBe(before.aborted + 1);
    expect(objectsOf(C.kyero)).toEqual([key]);
    expect(memory.objects.get(key as string)?.lastModified).toBe(stamp);
    expect((await dto(C.kyero)).feed).toEqual(feed1);
    // An unchanged run purges no edge copy (nothing changed at the URL).
    expect(purges).toEqual([]);
    expect((await runs(C.kyero)).items.map((r) => r.status)).toEqual(['UNCHANGED', 'WRITTEN']);
  });

  it('[S9-03] a changed listing rewrites the file: new object, old one deleted, new ETag, edge copies purged', async () => {
    const etag = (await served(TOKEN.kyero, 'kyero.xml')).file.etag;
    await readModel(a, 'two', { description: `Changed ${RUN}. ${DESCRIPTION}` });
    const result = await generate([C.kyero]);
    expect(result.written).toEqual([C.kyero]);
    expect(objectsOf(C.kyero)).toHaveLength(1);
    const now = await served(TOKEN.kyero, 'kyero.xml');
    expect(now.file.etag).not.toBe(etag);
    expect(now.xml).toContain(`Changed ${RUN}.`);
    expect(purges).toEqual([a.agencyId]);
  });
});

describe('[S9-03] one pass per agency', () => {
  it('[S9-03] two connections of an agency read each batch of documents once and get the same bytes as separate runs', async () => {
    C.generic = (await connect(a, 'generic-xml', 'Own site export')).connection.id;
    const docStatements = (fn: () => Promise<unknown>) => countQueries(fn, { match: /listing_read_models/ });
    // One pass over both live connections: one document statement for the batch.
    const both = await docStatements(() => generate());
    expect(both).toBe(1);
    const one = await docStatements(() => generate([C.kyero]));
    expect(one).toBe(1);
    // Each connection's file is what the S9-02 writer gives for it alone.
    for (const [id, file] of [
      [C.kyero, 'kyero.xml'],
      [C.generic, 'inmolink.xml'],
    ] as const) {
      const chunks: string[] = [];
      await writeConnectionFeed(a.agencyId, id, {
        mediaBaseUrl: MEDIA,
        sink: async (c) => {
          chunks.push(c);
        },
      });
      const key = objectsOf(id)[0] as string;
      const stored = gunzipSync(Buffer.from(memory.objects.get(key)?.body ?? new Uint8Array())).toString('utf8');
      expect(stored, file).toBe(chunks.join(''));
    }
    const kyero = gunzipSync(
      Buffer.from(memory.objects.get(objectsOf(C.kyero)[0] as string)?.body ?? new Uint8Array()),
    ).toString('utf8');
    expect(await schemaErrors(kyero, xsd('kyero/kyero-v3.xsd'))).toEqual([]);
  });
});

describe('[S9-03] delivery at tokenized URLs', () => {
  it('[S9-03] the token URL serves the stored file: strong ETag = content hash, only the portal format’s file name', async () => {
    const { file, xml } = await served(TOKEN.kyero, 'kyero.xml');
    const row = await dto(C.kyero);
    expect(file.connectionId).toBe(C.kyero);
    expect(file.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(file.tags).toEqual([websiteApi.edgeTag('p', C.kyero)]);
    expect(xml.match(/<property>/g)).toHaveLength(row.feed?.itemCount ?? -1);
    await expect(exportsModule.portalFeedFile(TOKEN.kyero, 'inmolink.xml')).rejects.toMatchObject({
      code: 'PORTAL_FEED_NOT_FOUND',
    });
    await expect(exportsModule.portalFeedFile('x'.repeat(43), 'kyero.xml')).rejects.toMatchObject({
      code: 'PORTAL_FEED_NOT_FOUND',
    });
  });

  it('[S9-03] app_public reads no connection column: only the SECURITY DEFINER lookup answers', async () => {
    const { withPublicRead } = await import('@inmolink/db');
    const denied = await withPublicRead((tx) =>
      tx.execute(sql`select credentials_enc from agency_portal_connections limit 1`),
    ).catch((err: unknown) => err as Error & { cause?: Error });
    expect(String((denied as { cause?: Error }).cause?.message)).toMatch(/permission denied/);
    const hash = exportsModule.portalFeedTokenHash(TOKEN.kyero);
    const rows = await withPublicRead((tx) => tx.execute(sql`select * from portal_feed_by_token(${hash})`));
    // Only what feed-api uses: never the agency, the token hash or anything else of the row.
    expect(Object.keys(rows.rows[0] ?? {}).sort()).toEqual(['channel_code', 'connection_id', 'run_id', 'sha256']);
  });

  it('[S9-03] a rotated or revoked token, or a connection turned off, stops serving; its stored files are removed', async () => {
    const rotated = await as(a, (ctx) => exportsModule.rotateConnectionToken(ctx, { connectionId: C.kyero }));
    await expect(exportsModule.portalFeedFile(TOKEN.kyero, 'kyero.xml')).rejects.toMatchObject({
      code: 'PORTAL_FEED_NOT_FOUND',
    });
    TOKEN.kyero = rotated.token;
    expect((await served(TOKEN.kyero, 'kyero.xml')).xml).toContain('<kyero>');

    await as(a, (ctx) => exportsModule.revokeConnectionToken(ctx, { connectionId: C.kyero }));
    await expect(exportsModule.portalFeedFile(TOKEN.kyero, 'kyero.xml')).rejects.toMatchObject({
      code: 'PORTAL_FEED_NOT_FOUND',
    });
    const skipped = await generate([C.kyero]);
    expect(skipped.skippedConnections).toEqual([{ connectionId: C.kyero, reason: 'revoked' }]);
    expect(objectsOf(C.kyero)).toEqual([]);
    expect((await dto(C.kyero)).feed).toBeNull();
    expect((await runs(C.kyero)).items[0]).toMatchObject({ status: 'SKIPPED', reason: 'revoked' });

    // Turned on again: a new file is generated (nothing points at deleted objects).
    TOKEN.kyero = (await as(a, (ctx) => exportsModule.rotateConnectionToken(ctx, { connectionId: C.kyero }))).token;
    expect((await generate([C.kyero])).written).toEqual([C.kyero]);
    expect((await served(TOKEN.kyero, 'kyero.xml')).xml).toContain(`<ref>${REF.one}</ref>`);

    // Turned off: the run removes its files.
    const current = await dto(C.kyero);
    await as(a, (ctx) =>
      exportsModule.updateConnection(ctx, { connectionId: C.kyero }, { version: current.version, enabled: false }),
    );
    await generate([C.kyero]);
    expect(objectsOf(C.kyero)).toEqual([]);
    await expect(exportsModule.portalFeedFile(TOKEN.kyero, 'kyero.xml')).rejects.toMatchObject({
      code: 'PORTAL_FEED_NOT_FOUND',
    });
    const off = await dto(C.kyero);
    await as(a, (ctx) =>
      exportsModule.updateConnection(ctx, { connectionId: C.kyero }, { version: off.version, enabled: true }),
    );
    expect((await generate([C.kyero])).written).toEqual([C.kyero]);
  });

  it('[S9-03] an agency no longer verified stops serving at once, and its next run removes the frozen file', async () => {
    await setAgencyStatus(a.agencyId, 'SUSPENDED');
    try {
      await expect(exportsModule.portalFeedFile(TOKEN.kyero, 'kyero.xml')).rejects.toMatchObject({
        code: 'PORTAL_FEED_NOT_FOUND',
      });
      expect((await generate([C.kyero])).skipped).toBe('not-verified');
      expect(objectsOf(C.kyero)).toEqual([]);
      expect(await currentRunId(C.kyero)).toBeNull();
    } finally {
      await setAgencyStatus(a.agencyId, 'VERIFIED');
    }
    expect((await runs(C.kyero)).items[0]).toMatchObject({ status: 'SKIPPED', reason: 'not-verified' });
    // Verified again: the next run writes the file anew.
    expect((await generate([C.kyero])).written).toEqual([C.kyero]);
    expect((await served(TOKEN.kyero, 'kyero.xml')).xml).toContain('<kyero>');
  });

  it('[S9-03] a portal whose writer is turned off stops serving: its next run removes the file', async () => {
    const key = exportsModule.portalFlagKey('thinkspain');
    const created = await connect(a, 'thinkspain', 'thinkSPAIN main');
    const id = created.connection.id;
    try {
      // The flag row may not exist yet on a fresh database (no other test created it).
      await system(async (tx) => {
        await setFlag(tx, key, { enabled: false });
        await setFlagOverride(tx, key, a.agencyId, true);
      });
      invalidateFlags();
      expect((await generate([id])).written).toEqual([id]);
      expect(objectsOf(id)).toHaveLength(1);
      await system((tx) => setFlagOverride(tx, key, a.agencyId, null));
      invalidateFlags();
      const off = await generate([id]);
      expect(off.skippedConnections).toEqual([{ connectionId: id, reason: 'writer-disabled' }]);
      expect(objectsOf(id)).toEqual([]);
      await expect(exportsModule.portalFeedFile(created.token, 'kyero.xml')).rejects.toMatchObject({
        code: 'PORTAL_FEED_NOT_FOUND',
      });
    } finally {
      await system((tx) => setFlagOverride(tx, key, a.agencyId, null));
      invalidateFlags();
      await as(a, (ctx) => exportsModule.deleteConnection(ctx, { connectionId: id }));
    }
  });
});

describe('[S9-03] run history and serialization', () => {
  it('[S9-03] run history is kept per connection up to FEED_RUNS_KEPT, newest first', async () => {
    for (let i = 0; i < exportsModule.FEED_RUNS_KEPT + 2; i++) await generate([C.kyero]);
    const list = await runs(C.kyero);
    expect(list.items).toHaveLength(exportsModule.FEED_RUNS_KEPT);
    expect(list.items[0]).toMatchObject({ trigger: 'EVENT', status: 'UNCHANGED', validCount: 3, invalidCount: 0 });
    const ids = list.items.map((r) => r.id);
    expect([...ids].sort().reverse()).toEqual(ids);
    const stored = await system(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from portal_feed_runs where connection_id = ${C.kyero}`,
          )
        ).rows[0]?.n,
    );
    expect(stored).toBe(exportsModule.FEED_RUNS_KEPT);
  });

  it('[S9-review] push runs have their own agency group; every heavy job of the pool shares one cap group', () => {
    const push = exportsJobs.pushPortalListings.spec;
    // Serialized per agency (so per connection) without holding the lease the agency's feed passes and site feeds use.
    expect(push.group?.({ agencyId: a.agencyId })).toBe(`${a.agencyId}:push`);
    expect(push.concurrencyPerGroup).toBe(1);
    expect(exportsJobs.generatePortalFeeds.spec.group?.({ agencyId: a.agencyId })).toBe(a.agencyId);
    const heavy = [
      exportsJobs.generatePortalFeeds,
      exportsJobs.generateNightlyPortalFeeds,
      exportsJobs.pushPortalListings,
      websiteApi.websiteApiJobs.generateSiteFeed,
    ].map((j) => j.spec);
    expect(new Set(heavy.map((s) => s.capGroup))).toEqual(new Set([websiteApi.EXPORTS_FEED_CAP_GROUP]));
    const cap = (c: number | (() => number) | undefined) => (typeof c === 'function' ? c() : c);
    configurePortalFeedJobs({ runsPerProcess: 3, maxConcurrentRuns: 9 });
    try {
      for (const s of heavy) expect([cap(s.perProcessConcurrency), cap(s.globalConcurrency)]).toEqual([3, 9]);
      // The lanes leave the other heavy jobs at least one pool-wide slot.
      expect(() => configurePortalFeedJobs({ nightlyLanes: 9, maxConcurrentRuns: 9 })).toThrow(/less than/);
    } finally {
      configurePortalFeedJobs({});
    }
    for (const s of heavy) expect([cap(s.perProcessConcurrency), cap(s.globalConcurrency)]).toEqual([2, 8]);
  });

  it('[S9-03] runs are serialized per agency, and a run that lost a race never replaces the newer file', async () => {
    const spec = exportsJobs.generatePortalFeeds.spec;
    const payload = { agencyId: a.agencyId, connectionId: C.kyero };
    expect(spec.pool).toBe('exports');
    expect(spec.group?.(payload)).toBe(a.agencyId);
    expect(spec.concurrencyPerGroup).toBe(1);
    // Defence in depth: two runs started from the same served file — only one is recorded as served.
    await readModel(a, 'three', { description: `Race ${RUN}. ${DESCRIPTION}` });
    const [x, y] = await Promise.all([generate([C.kyero]), generate([C.kyero])]);
    expect([...x.written, ...y.written]).toEqual([C.kyero]);
    expect([...x.failed, ...y.failed]).toEqual([C.kyero]);
    const keys = objectsOf(C.kyero);
    expect(keys).toHaveLength(1);
    expect((await served(TOKEN.kyero, 'kyero.xml')).xml).toContain(`Race ${RUN}`);
    // The loser is history as FAILED `SUPERSEDED` (no size, no hash: its object is gone); the winner is the served one.
    const [first, second] = (await runs(C.kyero)).items;
    const pair = [first, second].sort((p, q) => (p?.status ?? '').localeCompare(q?.status ?? ''));
    expect(pair).toMatchObject([
      { status: 'FAILED', reason: 'SUPERSEDED', bytes: null, validCount: 3 },
      { status: 'WRITTEN', reason: null, validCount: 3 },
    ]);
    expect(keys[0]).toContain(`/${await currentRunId(C.kyero)}/`);
    const row = await dto(C.kyero);
    expect(row.validation).toMatchObject({ validCount: 3, invalidCount: 0 });
  });
});

describe('[S9-03] triggers', () => {
  it('[S9-03] listing changes queue one throttled pass per agency; other agencies’ changes queue nothing', async () => {
    registerExportsSubscriptions();
    await publish(
      'search.publicDocs.changed',
      { agencyId: a.agencyId, targetIds: [L.one], developmentIds: [] },
      a.agencyId,
    );
    await publish(
      'properties.listing.updated',
      { listingId: L.one, agencyId: a.agencyId, version: 2, changed: ['tags'] },
      a.agencyId,
    );
    await publish(
      'properties.listing.updated',
      { listingId: L.one, agencyId: a.agencyId, version: 3, changed: ['price'] },
      a.agencyId,
    );
    const other = await createFounder();
    await publish(
      'search.publicDocs.changed',
      { agencyId: other.agencyId, targetIds: [newId()], developmentIds: [] },
      other.agencyId,
    );
    expect(enqueues).toEqual([
      {
        payload: { agencyId: a.agencyId },
        throttleMs: PORTAL_FEED_THROTTLE_MS,
        debounceKey: `portal-feeds:${a.agencyId}`,
      },
      {
        payload: { agencyId: a.agencyId },
        throttleMs: PORTAL_FEED_THROTTLE_MS,
        debounceKey: `portal-feeds:${a.agencyId}`,
      },
    ]);
  });

  it('[S9-03] listing changes during an import wait for its end; the live-connection answer is cached per agency', async () => {
    registerExportsSubscriptions();
    resetLiveConnectionCache();
    const changed = () =>
      publish(
        'search.publicDocs.changed',
        { agencyId: a.agencyId, targetIds: [L.one], developmentIds: [] },
        a.agencyId,
      );
    const feed = newId();
    const run = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into feed_connections (id, agency_id, name, connector, url)
                           values (${feed}, ${a.agencyId}, 'Import', 'kyero', 'https://feeds.example.com/k.xml')`);
      await tx.execute(sql`insert into feed_runs (id, agency_id, connection_id, trigger)
                           values (${run}, ${a.agencyId}, ${feed}, 'MANUAL')`);
    });
    try {
      const probes = await countQueries(async () => {
        await changed();
        await changed();
      });
      // Importing: nothing queued. The live-connection probe ran once for both events (cached), the import probe twice.
      expect(enqueues).toEqual([]);
      expect(probes).toBe(3);
      await publish(
        'imports.run.finished',
        { runId: run, connectionId: feed, agencyId: a.agencyId, state: 'SUCCEEDED', errorCode: null },
        a.agencyId,
      );
      expect(enqueues).toEqual([
        {
          payload: { agencyId: a.agencyId },
          throttleMs: PORTAL_FEED_THROTTLE_MS,
          debounceKey: `portal-feeds:${a.agencyId}`,
        },
      ]);
    } finally {
      await system((tx) => tx.execute(sql`delete from feed_connections where id = ${feed}`));
    }
  });

  it('[S9-03] an agency suspended or verified again purges the edge copies of every connection at once', async () => {
    registerExportsSubscriptions();
    await publish('agencies.status.changed', { agencyId: a.agencyId, from: 'VERIFIED', to: 'SUSPENDED' }, a.agencyId);
    // One coalesced purge of the agency's connection tags (`p`), queued at once.
    expect(purges).toEqual([a.agencyId]);
  });

  it('[S9-03] connection changes purge the URL and queue a throttled run of that connection', async () => {
    registerExportsSubscriptions();
    const event = (action: string) => ({ connectionId: C.kyero, agencyId: a.agencyId, action, version: 9 });
    await publish('exports.connection.changed', event('SELECTION_CHANGED'), a.agencyId);
    await publish('exports.connection.changed', event('TOKEN_ROTATED'), a.agencyId);
    expect(enqueues).toEqual([
      {
        payload: { agencyId: a.agencyId, connectionId: C.kyero },
        throttleMs: PORTAL_FEED_CONNECTION_THROTTLE_MS,
        debounceKey: `portal-feed:${C.kyero}`,
      },
      {
        payload: { agencyId: a.agencyId, connectionId: C.kyero },
        throttleMs: PORTAL_FEED_SOON_MS,
        debounceKey: `portal-feed:${C.kyero}`,
      },
    ]);
    expect(purges).toEqual([a.agencyId, a.agencyId]);
  });

  it('[S9-03] the nightly sweep seeds one chain per lane (never every agency), inside the window only', async () => {
    expect(nightlyWindow(new Date('2026-10-23T01:59:00Z'), 2)).toMatchObject({ day: '2026-10-22', open: false });
    expect(nightlyWindow(new Date('2026-10-23T02:10:00Z'), 2)).toMatchObject({ day: '2026-10-23', open: true });
    expect(await seedNightlyLanes(new Date('2026-10-23T12:00:00Z'))).toBe(0);
    const night = new Date(Date.now() - 60_000);
    const { day } = nightlyWindow(night, night.getUTCHours());
    configurePortalFeedJobs({ nightlyHourUtc: night.getUTCHours(), nightlyLanes: 3 });
    try {
      // Every other agency in this shared database is done for tonight: only this file's agency is due.
      await system((tx) =>
        tx.execute(sql`update agency_portal_connections
                          set nightly_at = case when agency_id = ${a.agencyId} then null else now() end`),
      );
      // Other files' connections created meanwhile may be due too: only this agency's chain is checked.
      expect(await seedNightlyLanes(night)).toBeGreaterThanOrEqual(1);
      expect(enqueues.filter((e) => e.payload.agencyId === a.agencyId)).toEqual([
        { payload: { agencyId: a.agencyId, nightly: day, lane: expect.any(Number), lanes: 3 } },
      ]);
      // A stable job id per agency and night (no throttle): a later sweep or a chain adding it again is a no-op.
      expect(
        exportsJobs.generateNightlyPortalFeeds.spec.jobId?.({ agencyId: a.agencyId, nightly: day, lane: 0, lanes: 3 }),
      ).toBe(`${a.agencyId}:${day}`);
      // Tonight's run covered it (a full pass counts too): the next sweep seeds nothing.
      await generate(undefined, 'EVENT');
      enqueues.length = 0;
      await seedNightlyLanes(night);
      expect(enqueues.filter((e) => e.payload.agencyId === a.agencyId)).toEqual([]);
    } finally {
      configurePortalFeedJobs({});
    }
  });
});
