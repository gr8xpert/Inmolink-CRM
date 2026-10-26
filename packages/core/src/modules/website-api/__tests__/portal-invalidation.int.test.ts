import { CreateListingBody, PortalQuery, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache, PageCache, RENDER_MARGIN_MS, redisPageTagStore } from '@inmolink/platform/cache';
import { clock, restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../index';

/**
 * S15-F7: the portal's ISR pages are invalidated on change. A listing's price change or withdrawal and an agency's
 * contact change reach the worker's outbox subscribers, which mark the pages' cache tags on redis-cache; a public
 * instance's page cache (platform `PageCache`, as `cache-handler.mjs` runs it) then drops the cached page on its next
 * request, and the page renders from fresh reads. Search pages read fresh data: the document at once, an agency's
 * contacts within a minute.
 */

const RUN = newId().slice(-8).toLowerCase();
const slug = (s: string) => `${s}-pi-${RUN}`;

let a: Founder;
let ids: { city: string; villa: string };
let listingId = '';
let code = '';

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('website-api.portal-invalidation.test', fn);

/** A public instance's page cache over the test's redis-cache prefix. */
const pageCache = () =>
  new PageCache({
    store: redisPageTagStore(),
    maxBytes: 10_000_000,
    now: () => clock.nowMs(),
  });

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

async function updateListing(patch: Partial<UpdateListingBody>): Promise<void> {
  await as(async (ctx) =>
    properties.updateListing(
      ctx,
      listingId,
      UpdateListingBody.parse({ ...patch, version: (await properties.getListing(ctx, listingId)).version }),
    ),
  );
  // The read-model job (debounced in the worker): the documents and their event change together.
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [listingId]));
}

const listingPage = async () => {
  const listing = await websiteApi.portalListing({ locale: 'en', code, requestId: newId() });
  return listing ? ({ kind: 'listing', locale: 'en', origin: 'https://inmolink.test', listing } as const) : null;
};
const searchCity = () =>
  websiteApi.portalSearch({ locale: 'en', locationIds: [ids.city], query: PortalQuery.parse({}), requestId: newId() });

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:portal-inv:${RUN}` });
  taxonomy.dropLocalTaxonomyCopies();
  websiteApi.resetPortalCaches();
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  a = await createFounder({ companyName: `Fresh Homes ${RUN}` });
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string, s: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: slug(s) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: slug('c'),
      translations: name('Freshland', 'freshland'),
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
      translations: name('Bay', 'bay'),
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
  listingId = (
    await as((ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 30_000_000,
          bedrooms: 3,
          energyRating: 'B',
        }),
      ),
    )
  ).id;
  await updateListing({ status: 'ACTIVE', visibility: 'PUBLIC', shareScope: 'ALL' });
  code = (await system((tx) => search.publicCodes(tx, [listingId]))).get(listingId) as string;
  websiteApi.registerWebsiteApiSubscriptions();
  await deliver();
}, 180_000);

afterEach(() => {
  restoreClock();
});

afterAll(async () => {
  websiteApi.unregisterWebsiteApiSubscriptions();
  await closeCache();
  await closeDb();
});

describe('portal page cache invalidation (S15-F7)', () => {
  it('[S15-F7] a price change drops the cached listing page on every instance; the page renders the new price', async () => {
    const page = await listingPage();
    expect(page).not.toBeNull();
    const tags = websiteApi.portalPageTags(page as NonNullable<typeof page>);
    // The listing's own id (the own view's), its code and its agency.
    expect(tags).toEqual([
      websiteApi.portalPageTag.listing(listingId),
      websiteApi.portalPageTag.code(code),
      websiteApi.portalPageTag.agency(a.agencyId),
    ]);
    // Two public instances hold the rendered page.
    const instances = [pageCache(), pageCache()];
    const key = page?.listing.paths.en as string;
    const entry = { kind: 'APP_PAGE', html: '€300,000', headers: { 'x-next-cache-tags': tags.join(',') } };
    // Rendered past the last mark's render margin (the listing was just published).
    useFakeClock(clock.nowMs() + RENDER_MARGIN_MS + 1);
    for (const c of instances) await c.set(key, entry);
    for (const c of instances) expect(await c.get(key)).not.toBeNull();
    restoreClock();

    await updateListing({ priceCents: 29_000_000 });
    expect(await deliver()).toContain('search.publicDocs.changed');
    for (const c of instances) expect(await c.get(key)).toBeNull();
    // The new render reads the document itself: the new price at once.
    expect((await listingPage())?.listing.detail.price.amountCents).toBe(29_000_000);
  });

  it('[S15-F7] a withdrawn listing: its page 404s and it leaves the search at once; cached copies are dropped; restored, its cached 404 is dropped', async () => {
    const c = pageCache();
    const page = await listingPage();
    const key = page?.listing.paths.en as string;
    expect((await searchCity()).items.map((i) => i.card.id)).toContain(listingId);
    // Rendered past the last mark's render margin: a copy the next change must drop.
    useFakeClock(clock.nowMs() + RENDER_MARGIN_MS + 1);
    await c.set(key, {
      kind: 'APP_PAGE',
      html: 'x',
      headers: { 'x-next-cache-tags': websiteApi.portalPageTags(page as NonNullable<typeof page>).join(',') },
    });
    expect(await c.get(key)).not.toBeNull();
    restoreClock();
    await updateListing({ status: 'WITHDRAWN' });
    expect(await listingPage()).toBeNull();
    expect((await searchCity()).items.map((i) => i.card.id)).not.toContain(listingId);
    expect(await deliver()).toContain('search.publicDocs.changed');
    expect(await c.get(key)).toBeNull();

    // The 404 is cached with the code its URL names (all the page knows); the listing is restored: the 404 goes.
    useFakeClock(clock.nowMs() + RENDER_MARGIN_MS + 1);
    await c.set(
      key,
      { kind: 'APP_PAGE', html: 'not found', status: 404, headers: {} },
      {
        tags: [websiteApi.portalPageTag.code(code)],
      },
    );
    expect(await c.get(key)).not.toBeNull();
    restoreClock();
    await updateListing({ status: 'ACTIVE' });
    expect(await deliver()).toContain('search.publicDocs.changed');
    expect(await c.get(key)).toBeNull();
    expect(await listingPage()).not.toBeNull();
  });

  it('[S15-F7] an agency’s contact change: its pages stay uncached until every cache shows it (≤ 1 minute)', async () => {
    const start = clock.nowMs();
    const fake = useFakeClock(start);
    // Warm: the agency's contacts are cached in this process.
    const before = await listingPage();
    expect(before?.listing.agency?.email).not.toBe(`hola-${RUN}@fresh.example`);
    const profile = await as((ctx) => agencies.getAgencyProfile(ctx));
    await as((ctx) =>
      agencies.updateAgencyProfile(ctx, {
        version: profile.version,
        primaryColor: profile.primaryColor,
        accentColor: profile.accentColor,
        contactEmail: `hola-${RUN}@fresh.example`,
        contactPhone: profile.contactPhone,
        websiteUrl: profile.websiteUrl,
        translations: profile.translations,
      }),
    );
    expect(await deliver()).toContain('agencies.profile.updated');
    const c = pageCache();
    const key = before?.listing.paths.en as string;
    const tagged = {
      kind: 'APP_PAGE',
      html: 'x',
      headers: { 'x-next-cache-tags': websiteApi.portalPageTags(before as NonNullable<typeof before>).join(',') },
    };
    // A render within the settle window may still read the old contacts (this process's cache): never kept.
    fake.advance(30_000);
    await c.set(key, tagged);
    fake.advance(1);
    expect(await c.get(key)).toBeNull();
    // Within a minute the process's agency cache has turned over: the page shows the new contacts…
    fake.set(start + 60_001);
    expect((await listingPage())?.listing.agency?.email).toBe(`hola-${RUN}@fresh.example`);
    // …and once the settle and the render margin have passed, a fresh render is kept again.
    fake.set(start + websiteApi.PORTAL_AGENCY_SETTLE_MS + RENDER_MARGIN_MS + 1);
    await c.set(key, tagged);
    fake.advance(1);
    expect(await c.get(key)).not.toBeNull();
  });
});
