import { CreateListingBody, type CreateSiteInput, UpdateListingBody, WebsiteListingsQuery } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { configureCdn, createMemoryCdn, type MemoryCdn } from '@inmolink/platform/cdn';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as identity from '../../identity';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import * as websiteApi from '../index';

/**
 * Edge cache purge (S7-06): what a cached website answer showed names its `Cache-Tag`s; a listing edit, a site change,
 * or a key rotation reaches the purge job through the outbox and purges exactly those tags — within seconds, well
 * inside the 5-minute freshness target (ADR 0012 #5). The CDN is the platform adapter's memory fake.
 */

const RUN = newId().slice(-8);
const log = createLogger({ service: 'edge-test', level: 'silent' });
const jobCtx = (id: string) => ({
  log,
  jobId: id,
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

let a: Founder;
let ids: { country: string; city: string; villa: string };
let listingId = '';
let siteId = '';
let keyId = '';
let cdn: MemoryCdn;

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('website-api.edge.test', fn);
const site = () => websiteApi.siteForKey({ keyId, agencyId: a.agencyId, siteId }, newId());

const seen = new Set<string>();

/** The worker's path, minus BullMQ: the agency's outbox events since `since` through every subscriber, jobs run inline. */
async function deliver(since: Date): Promise<string[]> {
  const rows = await system((tx) =>
    tx.execute<{ id: string; agency_id: string; type: string; version: number; payload: unknown; created_at: Date }>(
      sql`select id, agency_id, type, version, payload, created_at from outbox_events
           where agency_id = ${a.agencyId} and created_at >= ${since} order by created_at, id`,
    ),
  );
  const delivered: string[] = [];
  for (const r of rows.rows) {
    // Each event once (an earlier test delivered its own).
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    for (const sub of defaultSubscribers.get(r.type, r.version)) {
      if (!sub.name.startsWith('websiteApi.edge.')) continue;
      await sub.handler(r.payload as never, {
        eventId: r.id,
        agencyId: r.agency_id,
        type: r.type,
        version: r.version,
        createdAt: new Date(r.created_at),
        attempt: 1,
      });
      delivered.push(r.type);
    }
  }
  return delivered;
}

async function updateListing(patch: Partial<UpdateListingBody>): Promise<void> {
  await as(async (ctx) =>
    properties.updateListing(
      ctx,
      listingId,
      UpdateListingBody.parse({ ...patch, version: (await properties.getListing(ctx, listingId)).version }),
    ),
  );
  // The read-model job (debounced in the worker): the public documents and their event change together.
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [listingId]));
}

const SITE: CreateSiteInput = {
  name: 'Edge Homes',
  domains: ['www.edge-homes.example'],
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'OWN_ONLY',
  inventoryFilters: null,
  referencePrefix: 'EH',
  locales: ['en'],
  contact: null,
};

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:edge:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  websiteApi.configureEdgeCache({ tagKey: 'test-edge-key-0123456789abcdef0123456789' });
  // The engine is unreachable: website search answers from the Postgres fallback.
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-edge-${RUN}` }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `edge-${RUN}`,
      translations: name('Edgeland'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: country,
        code: `edge-r-${RUN}`,
        translations: name('Rim'),
      }),
      code: `edge-c-${RUN}`,
      translations: name('Verge'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `edge-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `edge-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { country, city, villa };
  });
  listingId = (
    await as((ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 30_000_000,
          energyRating: 'B',
        }),
      ),
    )
  ).id;
  await updateListing({ status: 'ACTIVE', visibility: 'PUBLIC' });
  siteId = (await as((ctx) => websites.createSite(ctx, SITE))).id;
  keyId = (
    await as((ctx) =>
      identity.createApiKey(ctx, { name: 'WP', kind: 'SECRET', scopes: ['listings:read'], allowedOrigins: [], siteId }),
    )
  ).key.id;
  websiteApi.registerWebsiteApiSubscriptions();
  // The purge job's queue: enqueues are recorded (agency, throttle); `drain` runs the agency's job like the worker.
  vi.spyOn(websiteApi.websiteApiJobs.purgeEdgeCache, 'enqueue').mockImplementation(async (payload, options) => {
    enqueued.push({ agencyId: (payload as { agencyId: string }).agencyId, throttleMs: options?.throttleMs });
    return { id: newId() };
  });
}, 180_000);

const enqueued: { agencyId: string; throttleMs?: number }[] = [];
const purgeJob = () => websiteApi.websiteApiJobs.purgeEdgeCache.spec;

/** Runs the agency's purge job until nothing is pending (each run is one throttle window in the worker). */
async function drain(agencyId: string, attempt = 1): Promise<number> {
  let runs = 0;
  for (;;) {
    const before = enqueued.length;
    await purgeJob().run({ agencyId }, { ...jobCtx(`purge-${runs}`), attempt });
    runs++;
    if (!enqueued.slice(before).some((e) => e.agencyId === agencyId) || runs > 50) return runs;
  }
}

afterEach(() => {
  restoreClock();
  configureCdn(null);
});

afterAll(async () => {
  vi.restoreAllMocks();
  websiteApi.unregisterWebsiteApiSubscriptions();
  await closeCache();
  await closeDb();
});

/** Runs an event's website-api edge subscribers as the dispatcher would. */
async function publish(type: string, payload: unknown, agencyId: string, createdAt = new Date()): Promise<void> {
  for (const sub of defaultSubscribers.get(type, 1)) {
    if (!sub.name.startsWith('websiteApi.edge.')) continue;
    await sub.handler(payload as never, { eventId: newId(), agencyId, type, version: 1, createdAt, attempt: 1 });
  }
}

describe('edge cache purge (S7-06)', () => {
  it('[S7-06] a listing edit purges the tags its cached detail and first pages carry, within 5 minutes', async () => {
    cdn = createMemoryCdn();
    configureCdn(cdn);
    // What the CDN holds: the detail and a first page, each tagged with the site, the key and the listing.
    const ref = (await as((ctx) => properties.getListing(ctx, listingId))).ref as string;
    const detailSite = await site();
    await websiteApi.listingDetail(detailSite, ref);
    const detailTags = websiteApi.edgeTagsOf(detailSite) ?? [];
    const pageSite = await site();
    const page = await websiteApi.searchListings(pageSite, WebsiteListingsQuery.parse({ locations: ids.country }));
    expect(page.items).toHaveLength(1);
    const pageTags = websiteApi.edgeTagsOf(pageSite) ?? [];
    const listingTag = websiteApi.edgeTag('t', listingId);
    expect(detailTags).toEqual([websiteApi.edgeTag('s', siteId), websiteApi.edgeTag('k', keyId), listingTag]);
    expect(pageTags).toContain(listingTag);
    // Tags are keyed hashes: no id is ever sent.
    for (const tag of [...detailTags, ...pageTags]) {
      expect(tag).toMatch(/^[sktd][0-9a-f]{20}$/);
      for (const id of [listingId, siteId, keyId, a.agencyId])
        expect(tag).not.toContain(id.replaceAll('-', '').slice(0, 12));
    }

    const editedAt = Date.now();
    await updateListing({ priceCents: 31_000_000 });
    expect(await deliver(new Date(editedAt - 1_000))).toContain('search.publicDocs.changed');
    // The agency's purge run is queued behind its throttle window (one run per window per tenant).
    expect(enqueued.at(-1)).toEqual({ agencyId: a.agencyId, throttleMs: websiteApi.EDGE_PURGE_THROTTLE_MS });
    await drain(a.agencyId);
    expect(cdn.tags().has(listingTag)).toBe(true);
    // The site's other answers stay cached: only what showed the listing is purged.
    expect(cdn.tags().has(websiteApi.edgeTag('s', siteId))).toBe(false);
    expect(Date.now() - editedAt + websiteApi.EDGE_PURGE_THROTTLE_MS).toBeLessThan(5 * 60_000);
    const after = await websiteApi.listingDetail(await site(), ref);
    expect(after.price).toMatchObject({ amountCents: 31_000_000 });
  });

  it("[S7-06] site changes, key rotation and revocation, an agency's status and preferred agencies purge site and key tags", async () => {
    cdn = createMemoryCdn();
    configureCdn(cdn);
    const since = new Date(Date.now() - 1_000);
    const current = await as((ctx) => websites.getSite(ctx, { siteId }));
    await as((ctx) => websites.updateSite(ctx, { siteId }, { version: current.version, name: 'Edge Homes 2' }));
    await as((ctx) => identity.rotateApiKey(ctx, { keyId }));
    await deliver(since);
    await drain(a.agencyId);
    expect(cdn.tags()).toEqual(new Set([websiteApi.edgeTag('s', siteId), websiteApi.edgeTag('k', keyId)]));
    // Coalesced: both changes went out in one purge request.
    expect(cdn.purged).toHaveLength(1);
    const later = new Date(Date.now() - 1_000);
    await as((ctx) => identity.revokeApiKey(ctx, { keyId }));
    cdn.purged.length = 0;
    await deliver(later);
    await drain(a.agencyId);
    expect(cdn.tags()).toEqual(new Set([websiteApi.edgeTag('k', keyId)]));
    // A suspension (or reinstatement) purges every site of the agency; so does a change of who prefers it (its sites'
    // network view), queued under the agency whose sites show it.
    cdn.purged.length = 0;
    await publish(
      'agencies.status.changed',
      { agencyId: a.agencyId, from: 'VERIFIED', to: 'SUSPENDED', version: 2 },
      a.agencyId,
    );
    await drain(a.agencyId);
    expect(cdn.tags()).toEqual(new Set([websiteApi.edgeTag('s', siteId)]));
    cdn.purged.length = 0;
    const other = newId();
    await publish(
      'agencies.preferred.removed',
      { agencyId: other, preferredAgencyId: a.agencyId, actorUserId: newId(), impersonatedBy: null },
      other,
    );
    expect(enqueued.at(-1)?.agencyId).toBe(a.agencyId);
    await drain(a.agencyId);
    expect(cdn.tags()).toEqual(new Set([websiteApi.edgeTag('s', siteId)]));
  });

  it('[S7-06] purges: ≤ 100 tags per run, old listing tags dropped but site and key tags never, failures retried then alerted', async () => {
    const alerts: websiteApi.WebsiteAlert[] = [];
    websiteApi.configureWebsiteApi({
      mediaBaseUrl: 'https://media.example',
      cursorKey: 'test-cursor-key-0123456789abcdef0123',
      onAlert: (alert) => alerts.push(alert),
    });
    const agency = newId();
    const at = new Date('2026-10-21T10:00:00Z');
    useFakeClock(at);
    const old = new Date(at.getTime() - websiteApi.EDGE_PURGE_HORIZON_MS - 1);
    const fresh = new Date(at.getTime() - 60_000);
    const targets = Array.from({ length: 150 }, () => newId());
    // No purger configured (local, CI, edge cache off): nothing to do, the pending tags are dropped.
    await websiteApi.queueEdgePurge(agency, [{ kind: 't', id: targets[0] as string }], fresh);
    expect(await purgeJob().run({ agencyId: agency }, jobCtx('off'))).toEqual({ purged: 0, skipped: 'no-edge-cache' });
    cdn = createMemoryCdn();
    configureCdn(cdn);
    expect(await purgeJob().run({ agencyId: agency }, jobCtx('empty'))).toEqual({ purged: 0, dropped: 0 });
    // 150 fresh listing tags, 10 expired ones, and an expired site and key purge (they end access: never dropped).
    await websiteApi.queueEdgePurge(
      agency,
      targets.map((id) => ({ kind: 't' as const, id })),
      fresh,
    );
    await websiteApi.queueEdgePurge(
      agency,
      Array.from({ length: 10 }, () => ({ kind: 't' as const, id: newId() })),
      old,
    );
    await websiteApi.queueEdgePurge(
      agency,
      [
        { kind: 's', id: siteId },
        { kind: 'k', id: keyId },
      ],
      old,
    );
    expect(await drain(agency)).toBe(2);
    expect(cdn.purged.map((b) => b.length)).toEqual([100, 52]);
    const purged = cdn.tags();
    for (const id of targets) expect(purged.has(websiteApi.edgeTag('t', id))).toBe(true);
    expect(purged.has(websiteApi.edgeTag('s', siteId))).toBe(true);
    expect(purged.has(websiteApi.edgeTag('k', keyId))).toBe(true);
    // A refused purge (rate limited, Cloudflare down) puts its tags back and fails the attempt (the queue retries);
    // the last attempt raises the alert.
    let fail = true;
    const memory = createMemoryCdn();
    configureCdn({
      purgeTags: async (tags) => {
        if (fail) throw new Error('rate limited');
        await memory.purgeTags(tags);
      },
    });
    await websiteApi.queueEdgePurge(agency, [{ kind: 'k', id: keyId }], fresh);
    await expect(purgeJob().run({ agencyId: agency }, { ...jobCtx('try-1'), attempt: 1 })).rejects.toThrow(
      'rate limited',
    );
    expect(alerts).toEqual([]);
    await expect(
      purgeJob().run({ agencyId: agency }, { ...jobCtx('try-5'), attempt: purgeJob().attempts as number }),
    ).rejects.toThrow('rate limited');
    expect(alerts).toEqual([{ kind: 'edgePurge', agencyId: agency, tags: 1, error: 'Error' }]);
    fail = false;
    await drain(agency);
    expect(memory.tags()).toEqual(new Set([websiteApi.edgeTag('k', keyId)]));
    expect(purgeJob().globalConcurrency).toBe(1);
  });
});
