import {
  CreateDevelopmentBody,
  CreateListingBody,
  type CreateSiteInput,
  CreateUnitsBody,
  SetDevelopmentAccessBody,
  UpdateListingBody,
  WebsiteDevelopmentDetail,
  WebsiteDevelopmentPage,
  WebsiteDevelopmentsQuery,
  WebsiteListingPage,
  WebsiteListingsQuery,
  WebsiteUnitPage,
  WebsiteUnitsQuery,
} from '@inmolink/contracts';
import { closeDb, countQueries, withPublicRead, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { configureSearch, createMeiliEngine, type SearchEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as developmentsModule from '../../developments';
import * as identity from '../../identity';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import * as websiteApi from '../index';

/**
 * Website API v2 developments (S7-F6): new-build cards with price range and unit counts, a development's detail and
 * its live unit table — the site's inventory only (OPEN developments; AVAILABLE and RESERVED units), white-labelled
 * like listings (a network development by the site's code, never its owner's id, reference, name or contacts) — and
 * the `development` search filter for network developments, each within the query budget.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const UID = `t_wdev_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });
/** The engine stopped: website search answers from the Postgres fallback. */
const down = { ...createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 500 }) } as SearchEngine;

/** a: the site's agency (shares a listing: give-to-get open) · b: a developer on the network. */
let a: Founder;
let b: Founder;
let ids: { country: string; city: string; city2: string; flat: string };
/** Developments: a's own, b's OPEN one (with a sold unit), b's OPEN one in another city, b's PRIVATE_NETWORK one. */
const D: Record<'aOwn' | 'bOpen' | 'bOther' | 'bPrivate', string> = { aOwn: '', bOpen: '', bOther: '', bPrivate: '' };
const U: Record<string, string> = {};
const L: Record<string, string> = {};
const S: Record<string, string> = {};
const B_EMAIL = 'sales@devco-b.example';
const B_PHONE = '+34 600 987 654';
const B_WEBSITE = 'https://devco-b.example';

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('website-api.developments.test', fn);

const SITE: CreateSiteInput = {
  name: 'Costa Homes',
  domains: ['www.costa-homes.example'],
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'OWN_PLUS_NETWORK',
  inventoryFilters: null,
  referencePrefix: 'CH',
  locales: ['en'],
  // Test founders share one company name: the site's contact name tells the presenter from the owner.
  contact: { name: 'A Homes', phone: '+34 600 333 444' },
};

const site = (siteId: string) => websiteApi.siteForKey({ agencyId: a.agencyId, siteId }, newId());
const devCode = async (id: string) => (await withPublicRead((tx) => search.publicCodes(tx, [id]))).get(id) as string;
/** This run's developments only: the fallback rows are shared with other test files (network sites see theirs). */
const mine = (q: Partial<WebsiteDevelopmentsQuery> = {}) =>
  WebsiteDevelopmentsQuery.parse({ locations: ids.country, ...q }) as WebsiteDevelopmentsQuery;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

/** A development with texts naming its owner, and its units; returns the development id. */
async function development(
  m: Founder,
  key: string,
  locationId: string,
  units: { ref: string; status: 'AVAILABLE' | 'RESERVED' | 'SOLD'; priceCents: number; bedrooms: number }[],
  owner: { name: string },
  sharedWith?: string[],
): Promise<string> {
  const dev = await as(m, (ctx) =>
    developmentsModule.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({
        ref: code(`DV-${key}`),
        name: `${owner.name} Heights ${key}`,
        status: 'UNDER_CONSTRUCTION',
        completionDate: '2027-06-30',
        locationId,
        commission: { type: 'PCT', basisPoints: 400, includesVat: false },
      }),
    ),
  );
  // OPEN (public: on websites), or PRIVATE_NETWORK shared with some agencies (never on a website).
  await as(m, (ctx) =>
    developmentsModule.setDevelopmentAccess(
      ctx,
      dev.id,
      SetDevelopmentAccessBody.parse({
        version: dev.version,
        kind: sharedWith ? 'PRIVATE_NETWORK' : 'OPEN',
        allowedAgencyIds: sharedWith ?? [],
      }),
    ),
  );
  await system((tx) =>
    tx.execute(sql`
      insert into development_translations
        (development_id, agency_id, locale, title, description, payment_terms, slug, meta_title, meta_description)
      values (${dev.id}, ${m.agencyId}, 'en', ${`Seaside living by ${owner.name}`},
              ${`Built by ${owner.name}. Call ${B_PHONE} or mail ${B_EMAIL}, see ${B_WEBSITE}. Ref ${code(`DV-${key}`)}`},
              ${`10 % on reservation; questions: ${B_EMAIL}`}, ${`seaside-${key.toLowerCase()}`},
              ${`${owner.name} new homes`}, ${`New homes by ${owner.name}`})`),
  );
  const created = await as(m, (ctx) =>
    developmentsModule.createUnits(
      ctx,
      dev.id,
      CreateUnitsBody.parse({
        units: units.map((u) => ({ ...u, ref: `${key}-${u.ref}-${RUN}`, propertyTypeId: ids.flat, bathrooms: 1 })),
      }),
    ),
  );
  for (const u of created.items) U[u.ref.replace(`-${RUN}`, '')] = u.id;
  return dev.id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureCache({ prefix: `t:wdev:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  search.configureWebsiteSearch({ engineTimeoutMs: 5_000, slowMs: 4_000 });
  search.configureNetworkSearch({ giveToGetMinShared: 1, giveToGetGraceDays: 0 });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  [a, b] = [await createFounder(), await createFounder()];
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  await as(b, async (ctx) => {
    const current = await agencies.getAgencyProfile(ctx);
    await agencies.updateAgencyProfile(ctx, {
      version: current.version,
      primaryColor: '#123456',
      accentColor: null,
      contactEmail: B_EMAIL,
      contactPhone: B_PHONE,
      websiteUrl: B_WEBSITE,
      translations: [],
    });
  });
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('wd'),
      translations: name('Devland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('wd-r'),
      translations: name('Coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('wd-c'),
      translations: name('Alpha'),
    });
    const city2 = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('wd-c2'),
      translations: name('Beta'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('wd-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const flat = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('wd-flat'),
      sort: 0,
      translations: name('Flat'),
    });
    return { country, city, city2, flat };
  });
  // a shares one listing with the network: its websites may show network listings (give-to-get).
  const { id: listingId } = await as(a, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.flat,
        locationId: ids.city,
        priceCents: 30_000_000,
        energyRating: 'B',
      }),
    ),
  );
  await as(a, async (ctx) =>
    properties.updateListing(
      ctx,
      listingId,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, listingId)).version,
      }),
    ),
  );
  L.a = listingId;
  const aName = { name: 'Agency A' };
  const bName = { name: (await system((tx) => agencies.getAgencyName(tx, b.agencyId))) as string };
  D.aOwn = await development(
    a,
    'A',
    ids.city,
    [
      { ref: '1', status: 'AVAILABLE', priceCents: 20_000_000, bedrooms: 2 },
      { ref: '2', status: 'RESERVED', priceCents: 22_000_000, bedrooms: 3 },
    ],
    aName,
  );
  D.bOpen = await development(
    b,
    'B',
    ids.city,
    [
      { ref: '1', status: 'AVAILABLE', priceCents: 25_000_000, bedrooms: 1 },
      { ref: '2', status: 'AVAILABLE', priceCents: 30_000_000, bedrooms: 3 },
      { ref: '3', status: 'RESERVED', priceCents: 28_000_000, bedrooms: 2 },
      { ref: '4', status: 'SOLD', priceCents: 19_000_000, bedrooms: 4 },
    ],
    bName,
  );
  D.bOther = await development(
    b,
    'O',
    ids.city2,
    [{ ref: '1', status: 'AVAILABLE', priceCents: 40_000_000, bedrooms: 2 }],
    bName,
  );
  D.bPrivate = await development(
    b,
    'P',
    ids.city,
    [{ ref: '1', status: 'AVAILABLE', priceCents: 26_000_000, bedrooms: 2 }],
    bName,
    [a.agencyId],
  );
  await system(async (tx) => {
    await search.rebuildReadModels(tx, 'LISTING', [listingId]);
    await search.rebuildReadModels(tx, 'UNIT', Object.values(U));
  });
  S.net = (await as(a, (ctx) => websites.createSite(ctx, SITE))).id;
  S.own = (
    await as(a, (ctx) =>
      websites.createSite(ctx, { ...SITE, name: 'Own', inventoryPolicy: 'OWN_ONLY', referencePrefix: null }),
    )
  ).id;
  S.bOwn = (
    await as(b, (ctx) =>
      websites.createSite(ctx, {
        ...SITE,
        name: 'Devco',
        inventoryPolicy: 'OWN_ONLY',
        referencePrefix: 'BD',
        contact: null,
      }),
    )
  ).id;
  S.noNew = (
    await as(a, (ctx) =>
      websites.createSite(ctx, {
        ...SITE,
        name: 'Resale',
        inventoryPolicy: 'CUSTOM',
        inventoryFilters: {
          includeOwn: true,
          includeNetwork: true,
          locationIds: [],
          propertyTypeIds: [],
          newBuilds: false,
        },
      }),
    )
  ).id;
  configureSearch(real());
  search.configureSearchIndex({ uid: UID, scope: [listingId, ...Object.values(U)] });
  await search.ensureListingsIndex(real(), search.listingsIndex(UID));
  await search.syncIndex();
  search.resetSearchBreaker();
}, 180_000);

afterAll(async () => {
  configureSearch(real());
  await real()
    .dropIndex(UID)
    .catch(() => undefined);
  const targets = [...Object.values(U), ...Object.values(L)];
  if (targets.length > 0) {
    const all = sql.join(
      targets.map((t) => sql`${t}`),
      sql`, `,
    );
    await system(async (tx) => {
      await tx.execute(sql`delete from search_index_queue where target_id in (${all})`);
      await tx.execute(sql`delete from listing_search_docs where target_id in (${all})`);
      await tx.execute(sql`delete from listing_search_commissions where target_id in (${all})`);
    });
  }
  await closeCache();
  await closeDb();
});

describe('website API v2 developments (S7-F6)', () => {
  it("[S7-F6] /v2/developments lists the site's developments with price range and unit counts", async () => {
    const net = await site(S.net as string);
    const page = WebsiteDevelopmentPage.parse(await websiteApi.developments(net, mine()));
    const [bCode, aCode, otherCode] = [await devCode(D.bOpen), await devCode(D.aOwn), await devCode(D.bOther)];
    // Newest first; never the PRIVATE_NETWORK development (its units are not public), even though it is shared with a.
    // Network developments by the site's code, the agency's own by its own reference (as its listings).
    expect(page.items.map((d) => d.ref)).toEqual([`CH-${otherCode}`, `CH-${bCode}`, code('DV-A')]);
    expect(aCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    const bCard = page.items[1];
    expect(bCard).toMatchObject({
      kind: 'DEVELOPMENT',
      id: websites.siteScopedId(a.agencyId, D.bOpen),
      status: 'UNDER_CONSTRUCTION',
      completionDate: '2027-06-30',
      // AVAILABLE units' prices; the SOLD unit is not shown and counts nowhere.
      price: { fromCents: 25_000_000, toCents: 30_000_000, currency: 'EUR' },
      bedrooms: { min: 1, max: 3 },
      units: { total: 3, available: 2, reserved: 1 },
    });
    expect(bCard?.place.city?.id).toBe(ids.city);
    // The agency's own development keeps its id.
    expect(page.items[2]).toMatchObject({ id: D.aOwn, units: { total: 2, available: 1, reserved: 1 } });
    // Anywhere under a location; one page at a time with a cursor naming only a public code.
    const beta = WebsiteDevelopmentPage.parse(await websiteApi.developments(net, mine({ locations: [ids.city2] })));
    expect(beta.items.map((d) => d.ref)).toEqual([`CH-${otherCode}`]);
    const refs: string[] = [];
    let cursor: string | undefined;
    do {
      const p = WebsiteDevelopmentPage.parse(await websiteApi.developments(net, mine({ limit: 1, cursor })));
      refs.push(...p.items.map((d) => d.ref));
      if (p.nextCursor) {
        const decoded = Buffer.from(p.nextCursor, 'base64url').toString('utf8');
        for (const id of Object.values(D)) expect(decoded.includes(id)).toBe(false);
      }
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    expect(refs).toEqual(page.items.map((d) => d.ref));
    // Own-only: a's development alone, by its own reference.
    const own = WebsiteDevelopmentPage.parse(await websiteApi.developments(await site(S.own as string), mine()));
    expect(own.items.map((d) => d.ref)).toEqual([code('DV-A')]);
    // A CUSTOM site without new builds shows none, and no development or unit table.
    const resale = await site(S.noNew as string);
    expect((await websiteApi.developments(resale, mine())).items).toEqual([]);
    expect(await refusal(websiteApi.developmentDetail(resale, code('DV-A')))).toBe('DEVELOPMENT_NOT_FOUND');
    expect(await refusal(websiteApi.developmentUnits(resale, code('DV-A'), WebsiteUnitsQuery.parse({})))).toBe(
      'DEVELOPMENT_NOT_FOUND',
    );
  });

  it('[S7-F6] a network development and its units are white-labelled: no owner id, reference, name or contact', async () => {
    const net = await site(S.net as string);
    const bCode = await devCode(D.bOpen);
    const detail = WebsiteDevelopmentDetail.parse(await websiteApi.developmentDetail(net, `ch-${bCode.toLowerCase()}`));
    expect(detail).toMatchObject({ ref: `CH-${bCode}`, id: websites.siteScopedId(a.agencyId, D.bOpen) });
    expect(detail.agency.name).toBe('A Homes');
    expect(detail.description).toContain('Built by');
    const units = WebsiteUnitPage.parse(
      await websiteApi.developmentUnits(net, `CH-${bCode}`, WebsiteUnitsQuery.parse({})),
    );
    // The live table: AVAILABLE and RESERVED units in the developer's order, never the SOLD one.
    expect(units.items.map((u) => u.status)).toEqual(['AVAILABLE', 'AVAILABLE', 'RESERVED']);
    expect(units.items.map((u) => u.price.amountCents)).toEqual([25_000_000, 30_000_000, 28_000_000]);
    for (const u of units.items) {
      expect(u.ref).toMatch(/^CH-[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(u.development).toMatchObject({ id: detail.id, ref: detail.ref });
    }
    // Search cards link their development by the same reference.
    const found = WebsiteListingPage.parse(
      await websiteApi.searchListings(
        net,
        WebsiteListingsQuery.parse({ development: detail.ref, status: 'AVAILABLE,RESERVED' }),
      ),
    );
    const bName = (await system((tx) => agencies.getAgencyName(tx, b.agencyId))) as string;
    const unitRefs = (
      await system((tx) => tx.execute<{ ref: string }>(sql`select ref from units where development_id = ${D.bOpen}`))
    ).rows.map((r) => r.ref);
    const json = JSON.stringify([detail, units, found]);
    const leaks = [
      b.agencyId,
      D.bOpen,
      code('DV-B'),
      bName,
      B_EMAIL,
      'devco-b.example',
      '600 987 654',
      '600987654',
      ...unitRefs,
      ...Object.entries(U)
        .filter(([ref]) => ref.startsWith('B-'))
        .map(([, id]) => id),
    ];
    for (const leak of leaks) expect(json.includes(leak), leak).toBe(false);
    // Addressed only by the site's reference: not by the owner's development reference or id, nor another prefix,
    // nor the PRIVATE_NETWORK development's code.
    for (const ref of [code('DV-B'), D.bOpen, `W-${bCode}`, bCode, `CH-${await devCode(D.bPrivate)}`]) {
      expect(await refusal(websiteApi.developmentDetail(net, ref)), ref).toBe('DEVELOPMENT_NOT_FOUND');
      expect(await refusal(websiteApi.developmentUnits(net, ref, WebsiteUnitsQuery.parse({}))), ref).toBe(
        'DEVELOPMENT_NOT_FOUND',
      );
    }
    // The owner's own site shows it by the developer's own reference — never by the code network sites show, so a
    // buyer cannot carry a reference from the presenting agency's site to the owner's (or back).
    const owner = (siteId: string) => websiteApi.siteForKey({ agencyId: b.agencyId, siteId }, newId());
    const onOwner = await owner(S.bOwn as string);
    const ownDetail = WebsiteDevelopmentDetail.parse(await websiteApi.developmentDetail(onOwner, code('DV-B')));
    expect(ownDetail).toMatchObject({ ref: code('DV-B'), id: D.bOpen });
    expect(ownDetail.ref.includes(bCode)).toBe(false);
    for (const ref of [`BD-${bCode}`, `CH-${bCode}`, `W-${bCode}`]) {
      expect(await refusal(websiteApi.developmentDetail(onOwner, ref)), ref).toBe('DEVELOPMENT_NOT_FOUND');
    }
  });

  it('[S7-F6] the unit table pages with cursors that name only public codes', async () => {
    const net = await site(S.net as string);
    const ref = `CH-${await devCode(D.bOpen)}`;
    const all = WebsiteUnitPage.parse(await websiteApi.developmentUnits(net, ref, WebsiteUnitsQuery.parse({})));
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const p = WebsiteUnitPage.parse(
        await websiteApi.developmentUnits(net, ref, WebsiteUnitsQuery.parse({ limit: 1, cursor })),
      );
      paged.push(...p.items.map((u) => u.ref));
      if (p.nextCursor) {
        const decoded = Buffer.from(p.nextCursor, 'base64url').toString('utf8');
        for (const id of Object.values(U)) expect(decoded.includes(id)).toBe(false);
      }
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual(all.items.map((u) => u.ref));
    expect(
      await refusal(websiteApi.developmentUnits(net, ref, WebsiteUnitsQuery.parse({ cursor: 'eyJ1IjoxfQ' }))),
    ).toBe('VALIDATION_FAILED');
    // A cursor naming a unit that is not (or no longer) one of the development's: the position is gone.
    const elsewhere = (await withPublicRead((tx) => search.publicCodes(tx, [U['O-1'] as string]))).get(
      U['O-1'] as string,
    );
    const stale = Buffer.from(JSON.stringify({ u: elsewhere })).toString('base64url');
    expect(await refusal(websiteApi.developmentUnits(net, ref, WebsiteUnitsQuery.parse({ cursor: stale })))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it("[S7-F6] the development filter finds a network development's units by its site reference — engine and fallback", async () => {
    const net = await site(S.net as string);
    const bCode = await devCode(D.bOpen);
    const q = (development: string) =>
      WebsiteListingsQuery.parse({ development, kind: 'UNIT', status: 'AVAILABLE,RESERVED', sort: 'price_asc' });
    const shownUnits = ['B-1', 'B-3', 'B-2'];
    for (const engine of [real(), down]) {
      configureSearch(engine);
      search.resetSearchBreaker();
      search.resetDevelopmentCodes();
      const label = engine === down ? 'fallback' : 'engine';
      const page = WebsiteListingPage.parse(await websiteApi.searchListings(net, q(`CH-${bCode}`)));
      expect(page.degraded, label).toBe(engine === down);
      expect(
        page.items.map((i) => i.ref),
        label,
      ).toEqual(
        await Promise.all(
          shownUnits.map(
            async (r) =>
              `CH-${(await withPublicRead((tx) => search.publicCodes(tx, [U[r] as string]))).get(U[r] as string)}`,
          ),
        ),
      );
      // The owner's id or reference, another site's prefix, an unknown code: nothing.
      for (const other of [`W-${bCode}`, code('DV-B'), 'CH-ZZZZZZZZ', `CH-${await devCode(D.bPrivate)}`]) {
        expect((await websiteApi.searchListings(net, q(other))).items, `${label} ${other}`).toEqual([]);
      }
      // The id filter stays for own developments; another agency's real id finds nothing on a network site either
      // way it is spelt (cards show it scoped).
      const byId = await websiteApi.searchListings(
        net,
        WebsiteListingsQuery.parse({ developmentId: D.aOwn, kind: 'UNIT', status: 'AVAILABLE,RESERVED' }),
      );
      expect(byId.items.length, label).toBe(2);
      // The raw id of another agency's development finds nothing: network developments by their reference only.
      const networkId = await websiteApi.searchListings(
        net,
        WebsiteListingsQuery.parse({ developmentId: D.bOpen, kind: 'UNIT', status: 'AVAILABLE,RESERVED' }),
      );
      expect(networkId.items, label).toEqual([]);
      // An own development by its own reference.
      const byOwnRef = await websiteApi.searchListings(net, q(code('DV-A')));
      expect(byOwnRef.items.length, label).toBe(2);
    }
    configureSearch(real());
    search.resetSearchBreaker();
  });

  it('[S7-F6] development rows follow their units: counts change with a unit, a development without shown units leaves', async () => {
    const net = await site(S.net as string);
    const otherRef = `CH-${await devCode(D.bOther)}`;
    const status = async (unitStatus: 'AVAILABLE' | 'SOLD') => {
      await as(b, (ctx) =>
        developmentsModule.bulkUpdateUnits(ctx, D.bOther, {
          unitIds: [U['O-1'] as string],
          patch: { status: unitStatus },
        }),
      );
      await system((tx) => search.rebuildReadModels(tx, 'UNIT', [U['O-1'] as string]));
    };
    await status('SOLD');
    expect((await websiteApi.developments(net, mine())).items.map((d) => d.ref)).not.toContain(otherRef);
    expect(await refusal(websiteApi.developmentDetail(net, otherRef))).toBe('DEVELOPMENT_NOT_FOUND');
    await status('AVAILABLE');
    const back = WebsiteDevelopmentDetail.parse(await websiteApi.developmentDetail(net, otherRef));
    expect(back.units).toEqual({ total: 1, available: 1, reserved: 0 });
    expect(back.price).toEqual({ fromCents: 40_000_000, toCents: 40_000_000, currency: 'EUR' });
  });

  it('[S7-F6] each development endpoint answers within 3 queries, warm and cold', async () => {
    const net = await site(S.net as string);
    const ref = `CH-${await devCode(D.bOpen)}`;
    const units = WebsiteUnitsQuery.parse({});
    const filtered = WebsiteListingsQuery.parse({ development: ref, kind: 'UNIT' });
    configureSearch(real());
    search.resetSearchBreaker();
    // Warm: compiled owner identities and the resolved development code.
    await websiteApi.developments(net, mine());
    await websiteApi.searchListings(net, filtered);
    const warm = {
      list: await countQueries(() => websiteApi.developments(net, mine())),
      detail: await countQueries(() => websiteApi.developmentDetail(net, ref)),
      units: await countQueries(() => websiteApi.developmentUnits(net, ref, units)),
      search: await countQueries(() => websiteApi.searchListings(net, filtered)),
    };
    expect(warm).toEqual({ list: 2, detail: 2, units: 2, search: 2 });
    // Cold: no compiled identities, the development code not resolved yet (the engine needs its id: one statement).
    websiteApi.resetWebsiteApiCaches();
    search.resetDevelopmentCodes();
    const cold = {
      list: await countQueries(() => websiteApi.developments(net, mine())),
      detail: await countQueries(() => websiteApi.developmentDetail(net, ref)),
      units: await countQueries(() => websiteApi.developmentUnits(net, ref, units)),
      search: await countQueries(() => websiteApi.searchListings(net, filtered)),
    };
    expect(cold).toEqual({ list: 2, detail: 2, units: 2, search: 3 });
    // The fallback resolves the code inside its own statement: page + documents + overrides/identities — with the
    // breaker open (no engine call), and after a failed engine call once the code is known (a cold code costs the
    // failed engine request one more, once per process: like a site scope miss).
    configureSearch(down);
    search.resetSearchBreaker({ failureThreshold: 1 });
    search.resetDevelopmentCodes();
    expect(await countQueries(() => websiteApi.searchListings(net, filtered))).toBe(4);
    expect(search.searchBreakerState()).toBe('open');
    expect(await countQueries(() => websiteApi.searchListings(net, filtered))).toBe(3);
    search.resetSearchBreaker();
    expect(await countQueries(() => websiteApi.searchListings(net, filtered))).toBe(3);
    configureSearch(real());
    search.resetSearchBreaker();
    // An own-only site never reads overrides or identities: one statement each.
    const own = await site(S.own as string);
    const ownRef = code('DV-A');
    expect(await countQueries(() => websiteApi.developments(own, mine()))).toBe(1);
    expect(await countQueries(() => websiteApi.developmentDetail(own, ownRef))).toBe(1);
    expect(await countQueries(() => websiteApi.developmentUnits(own, ownRef, units))).toBe(1);
  });
});
