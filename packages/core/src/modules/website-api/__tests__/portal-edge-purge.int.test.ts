import {
  CreateDevelopmentBody,
  CreateListingBody,
  CreateUnitsBody,
  SetDevelopmentAccessBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { configureCdn, createMemoryCdn, type MemoryCdn } from '@inmolink/platform/cdn';
import { clock, restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as developmentsModule from '../../developments';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import { EDGE_PURGE_THROTTLE_MS } from '../edge-purge';
import * as websiteApi from '../index';
import { PORTAL_AGENCY_EDGE_PURGE_DELAY_MS, queueEdgePurge, queuePortalAgencyEdgePurge } from '../jobs';

/**
 * S15-F11: the portal's listing and development pages at the CDN. The public proxy tags each page answer with its
 * public code's edge tag (`portalEdgeTag`: every locale, every slug, a 404 too); the portal's outbox subscribers queue
 * the purge of those tags — a withdrawn listing is gone at the edge within a minute, an agency's pages once its change
 * settled. The CDN is the platform adapter's memory fake; the purge jobs run inline.
 */

const RUN = newId().slice(-8).toLowerCase();
const slug = (s: string) => `${s}-pe-${RUN}`;
const log = createLogger({ service: 'portal-edge-test', level: 'silent' });
const jobCtx = (id: string) => ({
  log,
  jobId: id,
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

let a: Founder;
let ids: { city: string; villa: string };
const listings: string[] = [];
const codes: string[] = [];
/** The development's own code and its unit's (S15-F11 review: development pages are purged on an agency change). */
let devCode = '';
let unitCode = '';
let cdn: MemoryCdn;

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('website-api.portal-edge.test', fn);

const seen = new Set<string>();

/** The worker's path, minus BullMQ: the agency's new outbox events through the portal subscribers. */
async function deliver(): Promise<string[]> {
  const rows = await system((tx) =>
    tx.execute<{ id: string; agency_id: string; type: string; version: number; payload: unknown; created_at: Date }>(
      sql`select id, agency_id, type, version, payload, created_at from outbox_events
           where agency_id = ${a.agencyId} order by created_at, id`,
    ),
  );
  const delivered: string[] = [];
  for (const r of rows.rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    for (const sub of defaultSubscribers.get(r.type, r.version)) {
      if (!sub.name.startsWith('websiteApi.portal.')) continue;
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

async function updateListing(id: string, patch: Partial<UpdateListingBody>): Promise<void> {
  await as(async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ ...patch, version: (await properties.getListing(ctx, id)).version }),
    ),
  );
  // The read-model job (debounced in the worker): the documents and their event change together.
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
}

/** The purge queues: enqueues recorded (agency, throttle), jobs run inline by `drain` / `runAgencyJob`. */
const purgeRuns: { agencyId: string; throttleMs?: number }[] = [];
const agencyRuns: { agencyId: string; throttleMs?: number; debounceKey?: string }[] = [];

/** Runs the agency's purge job until nothing is pending (each run is one throttle window in the worker). */
async function drain(agencyId: string): Promise<number> {
  let runs = 0;
  for (;;) {
    const before = purgeRuns.length;
    await websiteApi.websiteApiJobs.purgeEdgeCache.spec.run({ agencyId }, jobCtx(`purge-${runs}`));
    runs++;
    if (!purgeRuns.slice(before).some((e) => e.agencyId === agencyId) || runs > 50) return runs;
  }
}

/** The tag the public proxy puts on a portal page path (`server/portal-edge.ts`: the code its slug ends in). */
const tagOfPath = (path: string) => {
  const code = websiteApi.codeOfSlug(path.split('/').pop() as string);
  return code ? websiteApi.portalEdgeTag(code) : null;
};

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:portal-edge:${RUN}` });
  taxonomy.dropLocalTaxonomyCopies();
  websiteApi.resetPortalCaches();
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  websiteApi.configureEdgeCache({ tagKey: 'test-edge-tag-key-0123456789abcdef0123' });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  a = await createFounder({ companyName: `Edge Homes ${RUN}` });
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string, s: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: slug(s) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: slug('c'),
      translations: name('Edgeland', 'edgeland'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: country,
        code: slug('r'),
        translations: name('Coast', 'coast'),
      }),
      code: slug('ci'),
      translations: name('Cove', 'cove'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: slug('g'),
      sort: 0,
      translations: name('Homes', 'homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: slug('v'),
      sort: 0,
      translations: name('Villa', 'villa'),
    });
    return { city, villa };
  });
  for (const priceCents of [30_000_000, 45_000_000]) {
    const id = (
      await as((ctx) =>
        properties.createListing(
          ctx,
          CreateListingBody.parse({
            propertyTypeId: ids.villa,
            locationId: ids.city,
            priceCents,
            bedrooms: 3,
            energyRating: 'B',
          }),
        ),
      )
    ).id;
    await updateListing(id, { status: 'ACTIVE', visibility: 'PUBLIC', shareScope: 'ALL' });
    listings.push(id);
    codes.push((await system((tx) => search.publicCodes(tx, [id]))).get(id) as string);
  }
  const created = await as((ctx) =>
    developmentsModule.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({
        ref: slug('dv').toUpperCase(),
        name: `Harbour Edge ${RUN}`,
        status: 'UNDER_CONSTRUCTION',
        completionDate: '2027-06-30',
        locationId: ids.city,
        commission: { type: 'PCT', basisPoints: 400, includesVat: false },
      }),
    ),
  );
  await as((ctx) =>
    developmentsModule.setDevelopmentAccess(
      ctx,
      created.id,
      SetDevelopmentAccessBody.parse({ version: created.version, kind: 'OPEN', allowedAgencyIds: [] }),
    ),
  );
  const units = await as((ctx) =>
    developmentsModule.createUnits(
      ctx,
      created.id,
      CreateUnitsBody.parse({
        units: [
          {
            ref: `U1-${RUN}`,
            status: 'AVAILABLE',
            priceCents: 30_000_000,
            bedrooms: 2,
            propertyTypeId: ids.villa,
            bathrooms: 1,
          },
        ],
      }),
    ),
  );
  const unitId = units.items[0]?.id as string;
  await system((tx) => search.rebuildReadModels(tx, 'UNIT', [unitId]));
  const devCodes = await system((tx) => search.publicCodes(tx, [created.id, unitId]));
  devCode = devCodes.get(created.id) as string;
  unitCode = devCodes.get(unitId) as string;
  websiteApi.registerWebsiteApiSubscriptions();
  vi.spyOn(websiteApi.websiteApiJobs.purgeEdgeCache, 'enqueue').mockImplementation(async (payload, options) => {
    purgeRuns.push({ agencyId: (payload as { agencyId: string }).agencyId, throttleMs: options?.throttleMs });
    return { id: newId() };
  });
  vi.spyOn(websiteApi.websiteApiJobs.purgePortalAgencyPages, 'enqueue').mockImplementation(async (payload, options) => {
    agencyRuns.push({
      agencyId: (payload as { agencyId: string }).agencyId,
      throttleMs: options?.throttleMs,
      debounceKey: options?.debounceKey,
    });
    return { id: newId() };
  });
  // The publish events of the setup: nothing to purge yet.
  configureCdn(createMemoryCdn());
  await deliver();
  await drain(a.agencyId);
}, 180_000);

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

describe('portal pages at the edge (S15-F11)', () => {
  it('[S15-F11] a withdrawn listing’s page is purged at the edge within a minute, in every locale (its 404 too, once restored)', async () => {
    cdn = createMemoryCdn();
    configureCdn(cdn);
    const [listingId, code] = [listings[0] as string, codes[0] as string];
    const page = await websiteApi.portalListing({ locale: 'en', code, requestId: newId() });
    const paths = Object.values(page?.paths ?? {});
    expect(paths.length).toBeGreaterThan(1);
    // Every locale's URL carries the one tag of the listing's code (the proxy's `Cache-Tag`).
    const tag = websiteApi.portalEdgeTag(code) as string;
    expect(tag).toMatch(/^c[0-9a-f]{20}$/);
    for (const path of paths) expect(tagOfPath(path), path).toBe(tag);
    // Another slug of the code (a type or town changed; a made-up spelling) and its 404: the same tag.
    expect(tagOfPath(`/de/property/old-slug-${code.toLowerCase()}`)).toBe(tag);

    const before = purgeRuns.length;
    await updateListing(listingId, { status: 'WITHDRAWN' });
    expect(await deliver()).toContain('search.publicDocs.changed');
    // The agency's purge run is queued at once, one throttle window (5 s) out — well inside a minute.
    const queued = purgeRuns.slice(before);
    expect(queued.map((r) => r.agencyId)).toContain(a.agencyId);
    expect(Math.max(...queued.map((r) => r.throttleMs ?? 0))).toBe(EDGE_PURGE_THROTTLE_MS);
    expect(EDGE_PURGE_THROTTLE_MS).toBeLessThan(60_000);
    expect(await drain(a.agencyId)).toBe(1);
    expect(cdn.tags().has(tag)).toBe(true);
    // Only the changed listing's page: the other one stays cached.
    expect(cdn.tags().has(websiteApi.portalEdgeTag(codes[1] as string) as string)).toBe(false);

    // Restored: the edge's cached 404 of the code is purged the same way.
    cdn.purged.length = 0;
    await updateListing(listingId, { status: 'ACTIVE' });
    expect(await deliver()).toContain('search.publicDocs.changed');
    await drain(a.agencyId);
    expect(cdn.tags().has(tag)).toBe(true);
  });

  it('[S15-F11] an agency’s change purges all its portal pages at the edge once it settled (one throttled run, paged codes)', async () => {
    cdn = createMemoryCdn();
    configureCdn(cdn);
    const before = agencyRuns.length;
    const profile = await as((ctx) => agencies.getAgencyProfile(ctx));
    await as((ctx) =>
      agencies.updateAgencyProfile(ctx, {
        version: profile.version,
        primaryColor: profile.primaryColor,
        accentColor: profile.accentColor,
        contactEmail: `edge-${RUN}@edge.example`,
        contactPhone: profile.contactPhone,
        websiteUrl: profile.websiteUrl,
        translations: profile.translations,
      }),
    );
    expect(await deliver()).toContain('agencies.profile.updated');
    // Queued once the public caches show the change (settle + render margin), coalesced per agency.
    expect(agencyRuns.slice(before)).toEqual([
      {
        agencyId: a.agencyId,
        throttleMs: PORTAL_AGENCY_EDGE_PURGE_DELAY_MS,
        debounceKey: `portal-agency-edge:${a.agencyId}`,
      },
    ]);
    expect(PORTAL_AGENCY_EDGE_PURGE_DELAY_MS).toBeGreaterThanOrEqual(websiteApi.PORTAL_AGENCY_SETTLE_MS);
    expect(cdn.purged).toEqual([]);
    const job = websiteApi.websiteApiJobs.purgePortalAgencyPages.spec;
    // The run comes a window after the change (its throttle): settled, no follow-up.
    useFakeClock(clock.nowMs() + PORTAL_AGENCY_EDGE_PURGE_DELAY_MS + 1);
    const all = [...codes, unitCode, devCode];
    expect(await job.run({ agencyId: a.agencyId }, jobCtx('agency'))).toEqual({ queued: all.length, followUp: false });
    await drain(a.agencyId);
    // Listings, the unit and the development: every portal page of the agency.
    for (const code of all) expect(cdn.tags().has(websiteApi.portalEdgeTag(code) as string), code).toBe(true);

    // The codes are read a keyset page at a time (bounded statements): listings and units, then developments.
    const docCodes: string[] = [];
    type Cursor = { publishedAt: number; targetId: string } | null;
    let after: Cursor = null;
    for (let i = 0; i < 10; i++) {
      const cursor: Cursor = after;
      const page: { codes: string[]; next: Cursor } = await system((tx) =>
        search.agencyPublicCodesPage(tx, a.agencyId, cursor, 1),
      );
      docCodes.push(...page.codes);
      after = page.next;
      if (!after) break;
    }
    expect(new Set(docCodes)).toEqual(new Set([...codes, unitCode]));
    const devs = await system((tx) => search.agencyDevelopmentCodesPage(tx, a.agencyId, null, 1));
    expect(devs.codes).toEqual([devCode]);
    expect(await system((tx) => search.agencyDevelopmentCodesPage(tx, a.agencyId, devs.next, 1))).toEqual({
      codes: [],
      next: null,
    });

    // No edge cache configured: the job queues nothing.
    configureCdn(null);
    expect(await job.run({ agencyId: a.agencyId }, jobCtx('off'))).toEqual({ queued: 0, skipped: 'no-edge-cache' });
  });

  it('[S15-F11] review: a change inside the agency window gets one follow-up run after it, not dropped', async () => {
    configureCdn(createMemoryCdn());
    const job = websiteApi.websiteApiJobs.purgePortalAgencyPages.spec;
    const t0 = clock.nowMs() + 10 * PORTAL_AGENCY_EDGE_PURGE_DELAY_MS;
    const fake = useFakeClock(t0);
    const before = agencyRuns.length;
    await queuePortalAgencyEdgePurge(a.agencyId);
    // A second change 30 s later: in the worker its enqueue is dropped (throttle) - the run must see it.
    fake.set(t0 + 30_000);
    await queuePortalAgencyEdgePurge(a.agencyId);
    fake.set(t0 + PORTAL_AGENCY_EDGE_PURGE_DELAY_MS + 1);
    expect(await job.run({ agencyId: a.agencyId }, jobCtx('window'))).toMatchObject({ followUp: true });
    expect(agencyRuns.slice(before)).toHaveLength(3);
    // The follow-up, a window later: nothing changed since, so no further run.
    fake.set(t0 + 30_000 + 2 * PORTAL_AGENCY_EDGE_PURGE_DELAY_MS);
    expect(await job.run({ agencyId: a.agencyId }, jobCtx('follow-up'))).toMatchObject({ followUp: false });
    expect(agencyRuns.slice(before)).toHaveLength(3);
    await drain(a.agencyId);
  });

  it('[S15-F11] review: an agency backlog never delays a withdrawal: its purge is in the next run (within 60 s); stale backlog tags are dropped after the edge lifetime', async () => {
    cdn = createMemoryCdn();
    configureCdn(cdn);
    // A large agency's pages queued for purge (bulk set), 1,500 codes: 75 s of runs at 100 tags per 5 s.
    const backlog = Array.from({ length: 1_500 }, (_, i) =>
      websiteApi.portalEdgePurgeItem(`B${String(i).padStart(7, '0')}`),
    );
    await queueEdgePurge(a.agencyId, backlog, new Date(), { bulk: true });
    const [listingId, code] = [listings[0] as string, codes[0] as string];
    const tag = websiteApi.portalEdgeTag(code) as string;
    await updateListing(listingId, { status: 'WITHDRAWN' });
    expect(await deliver()).toContain('search.publicDocs.changed');
    // The very next run (one throttle window, 5 s) sends the withdrawal first, then 99 backlog tags.
    const purge = websiteApi.websiteApiJobs.purgeEdgeCache.spec;
    await purge.run({ agencyId: a.agencyId }, jobCtx('first'));
    expect(cdn.purged[0]).toContain(tag);
    expect(cdn.purged[0]).toHaveLength(100);
    expect(EDGE_PURGE_THROTTLE_MS).toBeLessThan(60_000);
    // Past the edge lifetime of a portal page, the rest of the backlog is dropped (those copies have expired).
    useFakeClock(clock.nowMs() + websiteApi.PORTAL_EDGE_TTL_MS + 1);
    expect(await purge.run({ agencyId: a.agencyId }, jobCtx('late'))).toEqual({ purged: 0, dropped: 1_401 });
    expect(cdn.purged).toHaveLength(1);
    restoreClock();
    await updateListing(listingId, { status: 'ACTIVE' });
    await deliver();
    await drain(a.agencyId);
  });
});
