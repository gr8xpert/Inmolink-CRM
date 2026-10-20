import {
  CreateListingBody,
  type CreateSiteInput,
  type ListingDetailDoc,
  type PublicListingSearch,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, withPublicRead, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { cacheConnection, closeCache, configureCache } from '@inmolink/platform/cache';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { configureSearch, createMeiliEngine, type SearchEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as identity from '../../identity';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websites from '../index';

/**
 * Website sites and inventory policies (S7-01): a site's policy decides which listings its website API search
 * returns — the agency's own, plus the network's, or a CUSTOM selection — and a change shows within 60 s (cache).
 * Searches run against both the engine and the Postgres fallback (the same filter compiles to either).
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const UID = `t_sites_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const CACHE_PREFIX = `t:sites:${RUN}`;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });
/** The engine stopped: website search answers from the Postgres fallback. */
const down = { ...createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 500 }) } as SearchEngine;

/** a: the site's agency · b: shares PUBLIC listings with ALL · c: PREFERRED, does not prefer a · d: prefers a. */
let a: Founder;
let b: Founder;
let c: Founder;
let d: Founder;
let ids: { country: string; cityA: string; cityB: string; villa: string; flat: string };
const L: Record<string, string> = {};

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('websites.sites.test', fn);

async function listing(
  m: Founder,
  body: Partial<CreateListingBody>,
  state: Pick<UpdateListingBody, 'visibility' | 'shareScope'>,
): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.cityA,
        priceCents: 30_000_000,
        energyRating: 'B',
        ...body,
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ status: 'ACTIVE', ...state, version: (await properties.getListing(ctx, id)).version }),
    ),
  );
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  return id;
}

const OWN_SITE: CreateSiteInput = {
  name: 'Costa Homes',
  domains: ['www.costa-homes.example'],
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'OWN_ONLY',
  inventoryFilters: null,
  referencePrefix: 'CH',
  locales: ['en', 'es'],
  contact: null,
};

/** The site's search results (ids, sorted) through its cached scope, from the engine or the fallback. */
async function results(siteId: string, engine: SearchEngine = real()): Promise<string[]> {
  const scope = websites.siteSearchScope(await websites.siteScope(siteId), newId());
  // Under this run's country: the fallback table is shared with other test files, network-wide sites see theirs too.
  const query: PublicListingSearch = { locale: 'en', locationIds: [ids.country] };
  const page = await search.searchPublicListings(scope, query, { engine });
  return [...page.ids].sort();
}
const sorted = (...xs: string[]) => [...xs].sort();

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

/** Runs this process's subscribers for the latest outbox event of `type` about `siteId` (the dispatcher's job). */
async function deliver(type: string, siteId: string): Promise<void> {
  const event = await system(async (tx) => {
    const r = await tx.execute<{ id: string; agency_id: string; version: number; payload: unknown; created_at: Date }>(
      sql`select id, agency_id, version, payload, created_at from outbox_events
           where type = ${type} and payload->>'siteId' = ${siteId} order by id desc limit 1`,
    );
    return r.rows[0];
  });
  if (!event) throw new Error(`no ${type} event`);
  const subscribers = defaultSubscribers.get(type, event.version);
  expect(subscribers.length).toBeGreaterThan(0);
  for (const s of subscribers) {
    await s.handler(event.payload as never, {
      eventId: event.id,
      agencyId: event.agency_id,
      type,
      version: event.version,
      createdAt: new Date(event.created_at),
      attempt: 1,
    });
  }
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureCache({ prefix: CACHE_PREFIX });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websites.registerWebsitesSubscriptions();
  search.configureWebsiteSearch({ engineTimeoutMs: 5_000, slowMs: 4_000 });
  [a, b, c, d] = [await createFounder(), await createFounder(), await createFounder(), await createFounder()];
  for (const m of [a, b, c, d]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  await as(d, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: a.agencyId }));
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('st'),
      translations: name('Siteland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('st-r'),
      translations: name('Coast'),
    });
    const city = (n: string) =>
      taxonomy.createLocation(tx, { level: 'CITY', parentId: region, code: code(`st-${n}`), translations: name(n) });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('st-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const type = (t: string) =>
      taxonomy.createPropertyType(tx, { groupId: group, key: code(`st-${t}`), sort: 0, translations: name(t) });
    return {
      country,
      cityA: await city('Alpha'),
      cityB: await city('Beta'),
      villa: await type('Villa'),
      flat: await type('Flat'),
    };
  });
  L.aVilla = await listing(a, {}, { visibility: 'PUBLIC' });
  L.aFlat = await listing(
    a,
    { propertyTypeId: ids.flat, locationId: ids.cityB, priceCents: 60_000_000 },
    { visibility: 'PUBLIC' },
  );
  L.aShared = await listing(a, {}, { visibility: 'SHARED', shareScope: 'ALL' });
  L.bAll = await listing(b, { priceCents: 40_000_000 }, { visibility: 'PUBLIC', shareScope: 'ALL' });
  L.bFlat = await listing(
    b,
    { propertyTypeId: ids.flat, priceCents: 45_000_000 },
    { visibility: 'PUBLIC', shareScope: 'ALL' },
  );
  L.bShared = await listing(b, {}, { visibility: 'SHARED', shareScope: 'ALL' });
  L.cPreferred = await listing(c, {}, { visibility: 'PUBLIC', shareScope: 'PREFERRED' });
  L.dPreferred = await listing(
    d,
    { locationId: ids.cityB, priceCents: 90_000_000 },
    { visibility: 'PUBLIC', shareScope: 'PREFERRED' },
  );

  configureSearch(real());
  search.configureSearchIndex({ uid: UID, scope: Object.values(L) });
  await search.ensureListingsIndex(real(), search.listingsIndex(UID));
  await search.syncIndex();
  search.resetSearchBreaker();
}, 180_000);

afterEach(() => restoreClock());

afterAll(async () => {
  websites.unregisterWebsitesSubscriptions();
  await real()
    .dropIndex(UID)
    .catch(() => undefined);
  if (Object.keys(L).length > 0) {
    const all = sql.join(
      Object.values(L).map((t) => sql`${t}`),
      sql`, `,
    );
    await system(async (tx) => {
      await tx.execute(sql`delete from search_index_queue where target_id in (${all})`);
      await tx.execute(sql`delete from listing_search_docs where target_id in (${all})`);
    });
  }
  await closeCache();
  await closeDb();
});

describe('website sites (S7-01)', () => {
  it('[S7-01] inventory policies: own only, own plus network, custom — engine and fallback agree', async () => {
    const own = await as(a, (ctx) => websites.createSite(ctx, OWN_SITE));
    const network = await as(a, (ctx) =>
      websites.createSite(ctx, { ...OWN_SITE, name: 'Network', inventoryPolicy: 'OWN_PLUS_NETWORK' }),
    );
    const custom = await as(a, (ctx) =>
      websites.createSite(ctx, {
        ...OWN_SITE,
        name: 'Villas in Alpha',
        inventoryPolicy: 'CUSTOM',
        inventoryFilters: {
          includeOwn: false,
          includeNetwork: true,
          locationIds: [ids.cityA],
          propertyTypeIds: [ids.villa],
          priceMaxCents: 50_000_000,
          newBuilds: false,
        },
      }),
    );
    const expected = {
      [own.id]: sorted(L.aVilla as string, L.aFlat as string),
      // Never SHARED-only listings, nor PREFERRED ones of owners that do not prefer the agency.
      [network.id]: sorted(
        L.aVilla as string,
        L.aFlat as string,
        L.bAll as string,
        L.bFlat as string,
        L.dPreferred as string,
      ),
      [custom.id]: [L.bAll as string],
    };
    for (const [siteId, want] of Object.entries(expected)) {
      expect(await results(siteId), siteId).toEqual(want);
      expect(await results(siteId, down), siteId).toEqual(want);
    }
  });

  it("[S7-01] changing a site's policy changes its results within 60 s (cache)", async () => {
    const clock = useFakeClock(Date.now());
    const site = await as(a, (ctx) => websites.createSite(ctx, OWN_SITE));
    expect(await results(site.id)).toEqual(sorted(L.aVilla as string, L.aFlat as string)); // cached now
    await as(a, (ctx) =>
      websites.updateSite(
        ctx,
        { siteId: site.id },
        { version: site.version, inventoryPolicy: 'OWN_PLUS_NETWORK', inventoryFilters: null },
      ),
    );
    // Without the event: the old scope until the shared entry (<= 45 s) and this process's copy (<= 15 s) expire.
    expect(await results(site.id)).toEqual(sorted(L.aVilla as string, L.aFlat as string));
    const redisKey = `${CACHE_PREFIX}:${websites.siteCacheKey(site.id)}`;
    const ttl = await cacheConnection().ttl(redisKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl + websites.SITE_CACHE.LOCAL_TTL_SECONDS).toBeLessThanOrEqual(60);
    await cacheConnection().del(redisKey); // what Redis does when that TTL runs out
    clock.advance(websites.SITE_CACHE.LOCAL_TTL_SECONDS * 1000 + 1);
    expect(await results(site.id)).toEqual(
      sorted(L.aVilla as string, L.aFlat as string, L.bAll as string, L.bFlat as string, L.dPreferred as string),
    );
  });

  it('[S7-01] the change event drops the cached site at once', async () => {
    const site = await as(a, (ctx) => websites.createSite(ctx, OWN_SITE));
    expect(await results(site.id, down)).toEqual(sorted(L.aVilla as string, L.aFlat as string));
    const changed = await as(a, (ctx) =>
      websites.updateSite(
        ctx,
        { siteId: site.id },
        {
          version: site.version,
          inventoryPolicy: 'CUSTOM',
          inventoryFilters: {
            includeOwn: true,
            includeNetwork: true,
            locationIds: [],
            propertyTypeIds: [ids.flat],
            newBuilds: true,
          },
        },
      ),
    );
    expect(changed).toMatchObject({ version: site.version + 1, inventoryPolicy: 'CUSTOM' });
    await deliver('websites.site.changed', site.id);
    expect(await results(site.id, down)).toEqual(sorted(L.aFlat as string, L.bFlat as string));
    const scope = await websites.siteScope(site.id);
    expect(scope).toMatchObject({ agencyId: a.agencyId, version: 2, referencePrefix: 'CH', defaultLocale: 'en' });
  });

  it('[S7-01] admins set sites up; edits need the current version; locales are content locales', async () => {
    const site = await as(a, (ctx) =>
      websites.createSite(ctx, {
        ...OWN_SITE,
        inventoryPolicy: 'CUSTOM',
        inventoryFilters: {
          includeOwn: true,
          includeNetwork: false,
          locationIds: [],
          propertyTypeIds: [],
          priceMaxCents: 90_000_000,
          newBuilds: true,
        },
        contact: { name: 'Sales desk', email: 'sales@costa-homes.example' },
      }),
    );
    // Saving the same setup (jsonb keeps its own key order) changes nothing: same version, no event.
    const same = await as(a, (ctx) =>
      websites.updateSite(
        ctx,
        { siteId: site.id },
        {
          version: site.version,
          inventoryPolicy: 'CUSTOM',
          inventoryFilters: site.inventoryFilters,
          contact: { email: 'sales@costa-homes.example', name: 'Sales desk' },
        },
      ),
    );
    expect(same.version).toBe(site.version);
    const stale = { version: site.version, name: 'Renamed' };
    await as(a, (ctx) => websites.updateSite(ctx, { siteId: site.id }, stale));
    expect(await refusal(as(a, (ctx) => websites.updateSite(ctx, { siteId: site.id }, stale)))).toBe(
      'VERSION_CONFLICT',
    );
    expect(await refusal(as(a, (ctx) => websites.createSite(ctx, { ...OWN_SITE, locales: ['xx'] })))).toBe(
      'VALIDATION_FAILED',
    );
    // Another agency's site does not exist for b.
    expect(await refusal(as(b, (ctx) => websites.getSite(ctx, { siteId: site.id })))).toBe('SITE_NOT_FOUND');
    const page = await as(a, (ctx) => websites.listSites(ctx, { limit: 100 }));
    expect(page.items.map((s) => s.id)).toContain(site.id);
    expect(await refusal(websites.siteScope(newId()))).toBe('SITE_NOT_FOUND');
  });

  it('[S7-01] API keys are bound to a site', async () => {
    const e = await createFounder();
    await setAgencyStatus(e.agencyId, 'VERIFIED');
    const base = { name: 'WP', kind: 'SECRET' as const, scopes: ['listings:read' as const], allowedOrigins: [] };
    // No site yet: the key gets the agency's first site, created OWN_ONLY.
    const first = await as(e, (ctx) => identity.createApiKey(ctx, base));
    expect(first.key.siteId).toEqual(expect.any(String));
    const created = await as(e, (ctx) => websites.getSite(ctx, { siteId: first.key.siteId as string }));
    expect(created).toMatchObject({ inventoryPolicy: 'OWN_ONLY', mode: 'WP_PLUGIN' });
    expect(
      await identity.authenticateApiKey({ key: first.secret, origin: undefined, scope: 'listings:read' }),
    ).toMatchObject({ agencyId: e.agencyId, siteId: first.key.siteId });
    // A named site of the agency; never another agency's.
    const other = await as(e, (ctx) => websites.createSite(ctx, { ...OWN_SITE, name: 'Second' }));
    const second = await as(e, (ctx) => identity.createApiKey(ctx, { ...base, siteId: other.id }));
    expect(second.key.siteId).toBe(other.id);
    const foreign = await as(a, (ctx) => websites.createSite(ctx, OWN_SITE));
    expect(await refusal(as(e, (ctx) => identity.createApiKey(ctx, { ...base, siteId: foreign.id })))).toBe(
      'SITE_NOT_FOUND',
    );
    // The database keeps a key on its site (guard trigger): a tenant cannot move it, nor create one without a site.
    const move = as(e, (ctx) =>
      ctx.tx.execute(sql`update api_keys set site_id = ${other.id} where id = ${first.key.id}`),
    );
    await expect(move).rejects.toThrow(/site/);
  });
});

describe('website serializer (S7-02)', () => {
  /** The founders' content locale (their read models' locale). */
  const LOCALE = 'es';
  const refOf = async (id: string) =>
    (await system((tx) => tx.execute<{ ref: string }>(sql`select ref from properties where id = ${id}`))).rows[0]
      ?.ref as string;
  /** The read model's detail document in `LOCALE`, as the website API reads it (app_public). */
  const detailOf = async (id: string) => {
    const row = (
      await withPublicRead((tx) =>
        tx.execute<{ agency_id: string; detail: ListingDetailDoc }>(
          sql`select agency_id, detail from listing_read_models where target_id = ${id} and locale = ${LOCALE}`,
        ),
      )
    ).rows[0];
    if (!row) throw new Error(`no public read model for ${id}`);
    const codes = await withPublicRead((tx) => search.publicCodes(tx, [id]));
    return { ownerAgencyId: row.agency_id, publicCode: codes.get(id) ?? null, doc: row.detail };
  };
  const codeOf = async (id: string) => (await withPublicRead((tx) => search.publicCodes(tx, [id]))).get(id) as string;
  /** A site's view of documents, with its agency's overrides read as the website API reads them (app_public). */
  const viewOf = async (siteId: string, ids: string[]): Promise<websites.SiteView> => {
    const site = await websites.siteScope(siteId);
    const owners = await withPublicRead(async (tx) => {
      const rows = await tx.execute<{ agency_id: string }>(
        sql`select distinct agency_id from listing_read_models where target_id in (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      );
      return agencies.ownerIdentities(
        tx,
        rows.rows.map((r) => r.agency_id),
      );
    });
    const overrides = await withPublicRead((tx) => properties.siteOverrides(tx, site.agencyId, ids, LOCALE));
    return {
      site,
      presenter: site.presenter,
      mediaBaseUrl: 'https://cdn.example',
      overrides,
      owners,
    };
  };

  it('[S7-02] override text is used for the overriding site only', async () => {
    const siteA = await as(a, (ctx) =>
      websites.createSite(ctx, { ...OWN_SITE, name: 'A network', inventoryPolicy: 'OWN_PLUS_NETWORK' }),
    );
    const siteD = await as(d, (ctx) =>
      websites.createSite(ctx, { ...OWN_SITE, name: 'D network', inventoryPolicy: 'OWN_PLUS_NETWORK' }),
    );
    const siteB = await as(b, (ctx) => websites.createSite(ctx, OWN_SITE));
    const bAll = L.bAll as string;
    await as(a, (ctx) =>
      properties.saveListingOverride(ctx, 'LISTING', bAll, LOCALE, {
        title: 'Our <em>favourite</em> villa',
        description: 'Described by agency A.',
      }),
    );
    // An override of a listing no public page shows (SHARED only) is not readable by public paths.
    await as(a, (ctx) =>
      properties.saveListingOverride(ctx, 'LISTING', L.bShared as string, LOCALE, { title: 'Hidden override' }),
    );
    const doc = await detailOf(bAll);
    const owner = { title: doc.doc.title, description: doc.doc.description };

    const forA = websites.serializeDetail(await viewOf(siteA.id, [bAll, L.bShared as string]), doc);
    expect(forA).toMatchObject({ title: 'Our favourite villa', description: 'Described by agency A.' });
    const readable = await withPublicRead((tx) =>
      properties.siteOverrides(tx, a.agencyId, [bAll, L.bShared as string], LOCALE),
    );
    expect([...readable.targets.keys()]).toEqual([bAll]);
    // Another network site, and the owner's own site, keep the owner's text.
    // (The owner's title here is its own reference, which a network site never shows: its code stands in.)
    const forD = websites.serializeDetail(await viewOf(siteD.id, [bAll]), doc);
    expect(forD.title).not.toContain('favourite');
    expect(forD.description).toBe(owner.description);
    const forB = websites.serializeDetail(await viewOf(siteB.id, [bAll]), doc);
    expect({ title: forB.title, description: forB.description }).toEqual(owner);
    // Even handed agency A's overrides, the owner's own site never applies them (overrides are for presented listings).
    const misuse = { ...(await viewOf(siteB.id, [bAll])), overrides: (await viewOf(siteA.id, [bAll])).overrides };
    expect(websites.serializeDetail(misuse, doc).title).toBe(owner.title);
  });

  it("[S7-02] public reads of overrides never return another agency's override (app_public: the agency filter scopes them)", async () => {
    const bAll = L.bAll as string;
    await as(d, (ctx) => properties.saveListingOverride(ctx, 'LISTING', bAll, LOCALE, { title: "D's own title" }));
    await as(a, (ctx) => properties.saveListingOverride(ctx, 'LISTING', bAll, LOCALE, { title: "A's own title" }));
    // app_public may read both agencies' rows (public website copy): only the repository's agency filter keeps
    // them apart, so each agency's read returns its own row and nothing else.
    const rows = await withPublicRead((tx) =>
      tx.execute<{ agency_id: string }>(sql`select agency_id from listing_overrides where target_id = ${bAll}`),
    );
    expect(new Set(rows.rows.map((r) => r.agency_id))).toEqual(new Set([a.agencyId, d.agencyId]));
    for (const [m, title] of [
      [a, "A's own title"],
      [d, "D's own title"],
    ] as const) {
      const got = await withPublicRead((tx) => properties.siteOverrides(tx, m.agencyId, [bAll], LOCALE));
      expect([...got.targets.values()].map((t) => t.title)).toEqual([title]);
      expect(got.developments.size).toBe(0);
    }
    for (const m of [b, c]) {
      const got = await withPublicRead((tx) => properties.siteOverrides(tx, m.agencyId, [bAll], LOCALE));
      expect(got.targets.size).toBe(0);
    }
  });

  it("[S7-02] network listings carry the site's reference prefix and the presenting agency, never the owner", async () => {
    const profile = (m: Founder, contactEmail: string, contactPhone: string, websiteUrl: string) =>
      as(m, async (ctx) => {
        const current = await agencies.getAgencyProfile(ctx);
        await agencies.updateAgencyProfile(ctx, {
          version: current.version,
          primaryColor: '#123456',
          accentColor: null,
          contactEmail,
          contactPhone,
          websiteUrl,
          translations: [],
        });
      });
    await profile(a, 'office@agency-a.example', '+34 600 111 222', 'https://agency-a.example');
    await profile(b, 'owner@agency-b.example', '+34 600 999 888', 'https://agency-b.example');
    const site = await as(a, (ctx) =>
      websites.createSite(ctx, {
        ...OWN_SITE,
        name: 'Presented',
        inventoryPolicy: 'OWN_PLUS_NETWORK',
        // Test founders share one company name: the site's contact name tells A from B here.
        contact: { name: 'A Homes', phone: '+34 600 333 444' },
      }),
    );
    // Without a contact name a site shows its agency's directory name.
    const plain = await as(a, (ctx) => websites.createSite(ctx, { ...OWN_SITE, name: 'Plain' }));
    const aName = await system((tx) => agencies.getAgencyName(tx, a.agencyId));
    expect((await websites.siteScope(plain.id)).presenter).toMatchObject({ name: aName, phone: '+34 600 111 222' });
    const bAll = L.bAll as string;
    const view = await viewOf(site.id, [bAll]);
    expect(view.presenter).toEqual({
      name: 'A Homes',
      email: 'office@agency-a.example',
      // The site's contact override wins over the agency profile's.
      phone: '+34 600 333 444',
      whatsapp: null,
      website: 'https://agency-a.example',
      primaryColor: '#123456',
      accentColor: null,
    });
    const served = websites.serializeDetail(view, await detailOf(bAll));
    // The site's prefix and the listing's opaque public code — never the owner's own reference.
    const code = await codeOf(bAll);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(served.ref).toBe(`CH-${code}`);
    const json = JSON.stringify(served);
    const bName = (await system((tx) => agencies.getAgencyName(tx, b.agencyId))) as string;
    const bRef = await refOf(bAll);
    for (const leak of [bName, 'owner@agency-b.example', '600 999 888', 'agency-b.example', b.agencyId, bRef]) {
      expect(json.includes(leak), leak).toBe(false);
    }
  });

  it("[S7-02] a network listing is found by the site's prefixed reference only — never by the owner's own", async () => {
    const site = await as(a, (ctx) =>
      websites.createSite(ctx, { ...OWN_SITE, name: 'Refs', inventoryPolicy: 'OWN_PLUS_NETWORK' }),
    );
    const bOnly = await as(b, (ctx) => websites.createSite(ctx, { ...OWN_SITE, referencePrefix: null }));
    const [bRef, aRef] = [await refOf(L.bAll as string), await refOf(L.aVilla as string)];
    const [bCode, aCode] = [await codeOf(L.bAll as string), await codeOf(L.aVilla as string)];
    // A code is the target's for good: a rebuild keeps it.
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [L.bAll as string]));
    expect(await codeOf(L.bAll as string)).toBe(bCode);
    const find = async (siteId: string, text: string, engine: SearchEngine) => {
      const scope = websites.siteSearchScope(await websites.siteScope(siteId), newId());
      const page = await search.searchPublicListings(scope, { locale: 'en', text }, { engine });
      expect(page.backend).toBe(engine === down ? 'fallback' : 'engine');
      return page.ids;
    };
    for (const engine of [real(), down]) {
      const label = engine === down ? 'fallback' : 'engine';
      search.resetSearchBreaker();
      // The owner's reference finds nothing on site A, bare or prefixed; A's form `CH-<code>` finds it, in any case.
      expect(await find(site.id, bRef, engine), label).toEqual([]);
      expect(await find(site.id, `CH-${bRef}`, engine), label).toEqual([]);
      expect(await find(site.id, `CH-${bCode}`, engine), label).toEqual([L.bAll]);
      expect(await find(site.id, `ch-${bCode.toLowerCase()}`, engine), label).toEqual([L.bAll]);
      // The site's own listings by their own reference; codes are for network listings only.
      expect(await find(site.id, aRef, engine), label).toEqual([L.aVilla]);
      expect(await find(site.id, `CH-${aCode}`, engine), label).toEqual([]);
      // The owner's own site finds its listing by its reference.
      expect(await find(bOnly.id, bRef, engine), label).toEqual([L.bAll]);
    }
  });
});
