import {
  CreateDevelopmentBody,
  CreateListingBody,
  CreateUnitsBody,
  PORTAL_PAGE_SIZE,
  PortalQuery,
  SetDevelopmentAccessBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withPublicRead, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as developmentsModule from '../../developments';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../index';

/**
 * The public portal's reads (S15-01): every agency's PUBLIC listings under a location, presented as their own agency's
 * (name and published profile, never white-labelled), a listing by its public code, the location tree by slugs and
 * zones — from the read models and the search adapter (here its Postgres fallback), within the page budgets.
 */

const RUN = newId().slice(-8).toLowerCase();
const slug = (s: string) => `${s}-pt-${RUN}`;

let a: Founder;
let b: Founder;
/** An agency taken off the directory (suspended) after publishing. */
let c: Founder;
let ids: { country: string; region: string; city: string; otherCity: string; villa: string; flat: string };
let zoneId = '';
const L = { aVilla: '', aFlat: '', bVilla: '', bShared: '', bOther: '' };
const D = { open: '', private: '', unlisted: '' };
const U = { listing: '' };
const unitIds: Record<string, string> = {};

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function listing(
  m: Founder,
  o: { type: string; city: string; priceCents: number; beds: number; visibility?: 'PUBLIC' | 'SHARED' },
): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: o.type,
        locationId: o.city,
        priceCents: o.priceCents,
        bedrooms: o.beds,
        bathrooms: 2,
        energyRating: 'B',
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.saveListingTranslation(ctx, id, 'en', {
      version: (await properties.getListing(ctx, id)).version,
      title: `Home ${RUN}`,
      description: `A bright home near the sea. ${'Lovely terrace and views. '.repeat(30)}`,
    }),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: o.visibility ?? 'PUBLIC',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  return id;
}

/** A development of `m` in the test city with these units; OPEN (public) or PRIVATE_NETWORK shared with `sharedWith`. */
async function development(
  m: Founder,
  key: string,
  units: { ref: string; status: 'AVAILABLE' | 'RESERVED' | 'SOLD'; priceCents: number; bedrooms: number }[],
  sharedWith?: string[],
): Promise<string> {
  const dev = await as(m, (ctx) =>
    developmentsModule.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({
        ref: slug(`dv-${key}`).toUpperCase(),
        name: `Marina Heights ${key} ${RUN}`,
        status: 'UNDER_CONSTRUCTION',
        completionDate: '2027-06-30',
        locationId: ids.city,
        commission: { type: 'PCT', basisPoints: 400, includesVat: false },
      }),
    ),
  );
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
  const created = await as(m, (ctx) =>
    developmentsModule.createUnits(
      ctx,
      dev.id,
      CreateUnitsBody.parse({
        units: units.map((u) => ({ ...u, ref: `${key}-${u.ref}-${RUN}`, propertyTypeId: ids.flat, bathrooms: 1 })),
      }),
    ),
  );
  for (const u of created.items) unitIds[u.ref.replace(`-${RUN}`, '')] = u.id;
  return dev.id;
}

const q = (input: Record<string, unknown> = {}) => PortalQuery.parse(input);
const codeOf = async (id: string) => (await withPublicRead((tx) => search.publicCodes(tx, [id]))).get(id) as string;

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:portal:${RUN}` });
  taxonomy.dropLocalTaxonomyCopies();
  websiteApi.resetPortalCaches();
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  // The engine is unreachable: the portal is answered by the Postgres fallback (no facets, keyset pages only).
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  a = await createFounder({ companyName: `Portal Homes ${RUN}` });
  b = await createFounder({ companyName: `Second Agency ${RUN}` });
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  await setAgencyStatus(b.agencyId, 'VERIFIED');
  ids = await withSystem('portal.test', async (tx) => {
    const name = (n: string, s: string) => [
      { locale: 'en', name: `${n} ${RUN}`, slug: slug(s) },
      { locale: 'es', name: `${n} ${RUN}`, slug: slug(`${s}-es`) },
    ];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: slug('c'),
      translations: name('Portaland', 'portaland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: slug('r'),
      translations: name('Costa', 'costa'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: slug('ci'),
      translations: name('Torre', 'torre'),
    });
    const otherCity = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: slug('co'),
      translations: name('Elsewhere', 'elsewhere'),
    });
    zoneId = await taxonomy.createLocationGroup(tx, {
      key: slug('z'),
      translations: name('South Coast', 'south-coast'),
      memberIds: [city],
    });
    const homes = await taxonomy.createPropertyTypeGroup(tx, {
      key: slug('houses'),
      sort: 0,
      translations: name('Houses', 'houses'),
    });
    const flats = await taxonomy.createPropertyTypeGroup(tx, {
      key: slug('apartments'),
      sort: 1,
      translations: name('Apartments', 'apartments'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: homes,
      key: slug('villa'),
      sort: 0,
      translations: name('Villa', 'villa'),
    });
    const flat = await taxonomy.createPropertyType(tx, {
      groupId: flats,
      key: slug('flat'),
      sort: 0,
      translations: name('Apartment', 'apartment'),
    });
    return { country, region, city, otherCity, villa, flat };
  });
  L.aVilla = await listing(a, { type: ids.villa, city: ids.city, priceCents: 40_000_000, beds: 4 });
  L.aFlat = await listing(a, { type: ids.flat, city: ids.city, priceCents: 15_000_000, beds: 2 });
  L.bVilla = await listing(b, { type: ids.villa, city: ids.city, priceCents: 90_000_000, beds: 5 });
  L.bShared = await listing(b, {
    type: ids.villa,
    city: ids.city,
    priceCents: 50_000_000,
    beds: 3,
    visibility: 'SHARED',
  });
  L.bOther = await listing(b, { type: ids.flat, city: ids.otherCity, priceCents: 20_000_000, beds: 1 });
  await withSystem('portal.test', (tx) => search.rebuildReadModels(tx, 'LISTING', Object.values(L)));
  D.open = await development(b, 'O', [
    { ref: '2', status: 'AVAILABLE', priceCents: 30_000_000, bedrooms: 3 },
    { ref: '1', status: 'AVAILABLE', priceCents: 25_000_000, bedrooms: 1 },
    { ref: '3', status: 'RESERVED', priceCents: 28_000_000, bedrooms: 2 },
    { ref: '4', status: 'SOLD', priceCents: 19_000_000, bedrooms: 4 },
  ]);
  D.private = await development(
    b,
    'P',
    [{ ref: '1', status: 'AVAILABLE', priceCents: 26_000_000, bedrooms: 2 }],
    [a.agencyId],
  );
  // An agency that published, then left the directory (suspended): none of its stock is on the portal.
  c = await createFounder({ companyName: `Gone Agency ${RUN}` });
  await setAgencyStatus(c.agencyId, 'VERIFIED');
  U.listing = await listing(c, { type: ids.villa, city: ids.city, priceCents: 33_000_000, beds: 3 });
  D.unlisted = await development(c, 'U', [{ ref: '1', status: 'AVAILABLE', priceCents: 27_000_000, bedrooms: 2 }]);
  await withSystem('portal.test', async (tx) => {
    await search.rebuildReadModels(tx, 'LISTING', [L.aVilla, L.aFlat, L.bVilla, L.bShared, L.bOther, U.listing]);
    await search.rebuildReadModels(tx, 'UNIT', Object.values(unitIds));
  });
  await setAgencyStatus(c.agencyId, 'SUSPENDED');
  websiteApi.resetPortalCaches();
}, 180_000);

afterAll(async () => {
  await closeCache();
  await closeDb();
});

const searchCity = (query = q()) =>
  websiteApi.portalSearch({ locale: 'en', locationIds: [ids.city], query, requestId: newId() });

describe('public portal reads (S15-01)', () => {
  it('[S15-01] location tree: slugs resolve from the country down, zones by slug, alternates per locale', async () => {
    const loc = await websiteApi.portalLocation('en', [slug('portaland'), slug('costa')]);
    expect(loc?.place).toMatchObject({ id: ids.region, level: 'REGION', path: [slug('portaland'), slug('costa')] });
    expect(loc?.ancestors.map((p) => p.id)).toEqual([ids.country]);
    expect(loc?.children.map((c) => c.id).sort()).toEqual([ids.city, ids.otherCity].sort());
    expect(await websiteApi.portalLocation('en', [slug('costa')])).toBeNull();
    expect(await websiteApi.portalLocation('en', [slug('portaland'), 'nowhere'])).toBeNull();
    expect((await websiteApi.portalLocationPaths(ids.city, ['en', 'es'])).es).toEqual([
      slug('portaland-es'),
      slug('costa-es'),
      slug('torre-es'),
    ]);
    const zone = await websiteApi.portalZone('en', slug('south-coast'));
    expect(zone?.members.map((m) => m.id)).toEqual([ids.city]);
    expect(await websiteApi.portalZoneSlugs(zoneId, ['es'])).toEqual({ es: slug('south-coast-es') });
    const place = await websiteApi.portalPlaceOf('en', ids.city);
    expect(place?.ancestors.map((p) => p.id)).toEqual([ids.country, ids.region]);
  });

  it('[S15-01] search: every agency’s PUBLIC listings under a location, each shown as its own agency’s', async () => {
    const page = await searchCity();
    const refs = page.items.map((i) => i.card.id).sort();
    expect(refs).toEqual([L.aVilla, L.aFlat, L.bVilla].sort());
    expect(page.total).toBe(3);
    expect(page.pageCount).toBe(1);
    const bCard = page.items.find((i) => i.card.id === L.bVilla);
    // The portal names the listing agency (no white-label): its own reference, its published directory name.
    expect(bCard?.agency).toMatchObject({ id: b.agencyId, name: expect.stringContaining('Second Agency') });
    expect(bCard?.card.ref).not.toMatch(/^W-/);
    expect(bCard?.code).toBe(await codeOf(L.bVilla));
    expect(bCard?.excerpt?.length).toBeLessThanOrEqual(websiteApi.PORTAL_EXCERPT_CHARS);
    expect(bCard?.excerpt).toMatch(/^A bright home near the sea/);
    // Never commission, owner (vendor) contacts or internal notes: they are not in what the portal reads.
    expect(JSON.stringify(page.items)).not.toMatch(/commission|internalNote|ownerContact/i);
  });

  it('[S15-F6] portal cards read the card document only: no statement touches detail; the card carries excerpt and terrace', async () => {
    await searchCity();
    const sqls: string[] = [];
    await countQueries(() => searchCity(), { onQuery: (query) => sqls.push(query) });
    const reads = sqls.filter((s) => /listing_read_models/.test(s));
    expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) expect(s).not.toMatch(/\bdetail\b/i);

    const docs = await withPublicRead((tx) => search.publicDocs(tx, [L.bVilla], 'portal', 'en', 'en'));
    const doc = docs[0]?.doc as { portalText?: string | null; portalTerraceM2?: number | null };
    expect(doc.portalText).toMatch(/^A bright home near the sea/);
    expect(doc.portalText?.length).toBeLessThanOrEqual(300);
    expect(doc).toHaveProperty('portalTerraceM2');
    // The detail document has no copy of the extras.
    const full = await withPublicRead((tx) => search.publicDocs(tx, [L.bVilla], 'detail', 'en', 'en'));
    expect(full[0]?.doc).not.toHaveProperty('portalText');
  });

  it('[S15-01] filters: price, bedroom range, type group by slug; an unknown type matches nothing', async () => {
    const byPrice = await searchCity(q({ price_min: '200000', price_max: '500000' }));
    expect(byPrice.items.map((i) => i.card.id)).toEqual([L.aVilla]);
    const byBeds = await searchCity(q({ bedrooms_min: '2', bedrooms_max: '4' }));
    expect(byBeds.items.map((i) => i.card.id).sort()).toEqual([L.aVilla, L.aFlat].sort());
    const houses = await searchCity(q({ type: slug('houses'), sort: 'price_desc' }));
    expect(houses.items.map((i) => i.card.id)).toEqual([L.bVilla, L.aVilla]);
    // The filter offers a bounded list; URL slugs resolve against the whole catalog (the shared test DB's is large).
    const catalog = await websiteApi.portalCatalog('en');
    expect(catalog.filterGroups.flatMap((g) => g.types).length).toBeLessThanOrEqual(websiteApi.PORTAL_MAX_FILTER_TYPES);
    expect(catalog.typeGroups.some((g) => g.slug === slug('houses'))).toBe(true);
    const unknown = await searchCity(q({ type: 'no-such-type' }));
    expect(unknown).toMatchObject({ total: 0, items: [] });
  });

  it('[S15-01] numbered pages: a deep page the fallback cannot answer is flagged, never a wrong page', async () => {
    const deep = await searchCity(q({ page: '2' }));
    expect(deep.pageUnavailable).toBe(true);
    expect(deep.items).toEqual([]);
  });

  it('[S15-01] budgets: a search page ≤ 3 statements, a listing page ≤ 2 (warm caches)', async () => {
    await searchCity();
    expect(await countQueries(() => searchCity())).toBeLessThanOrEqual(3);
    const code = await codeOf(L.aVilla);
    await websiteApi.portalListing({ locale: 'en', code, requestId: newId() });
    let listing: websiteApi.PortalListing | null = null;
    const statements = await countQueries(async () => {
      listing = await websiteApi.portalListing({ locale: 'en', code: code.toLowerCase(), requestId: newId() });
    });
    expect(statements).toBeLessThanOrEqual(2);
    expect(listing).toMatchObject({ code, agency: { id: a.agencyId }, detail: { id: L.aVilla, kind: 'LISTING' } });
  });

  it('[S15-01] listing page: only a PUBLIC listing’s code names one; SHARED listings and junk codes name none', async () => {
    // A SHARED listing is not public: it has no public code, so no portal URL can name it.
    expect(await codeOf(L.bShared)).toBeUndefined();
    expect(await websiteApi.portalListing({ locale: 'en', code: 'not-a-code', requestId: newId() })).toBeNull();
    const detail = await websiteApi.portalListing({ locale: 'es', code: await codeOf(L.bVilla), requestId: newId() });
    // No Spanish text: the English document (the fallback locale), the owner's own reference and presenter.
    expect(detail?.detail.agency.name).toContain('Second Agency');
    expect(detail?.detail.ref).not.toMatch(/^W-/);
  });

  it('[S15-01] a search page renders one page of cards (never more than the page size), units stay out of search', async () => {
    const everywhere = await websiteApi.portalSearch({ locale: 'en', query: q(), requestId: newId() });
    expect(everywhere.items.length).toBeLessThanOrEqual(PORTAL_PAGE_SIZE);
    const inCity = await searchCity();
    expect(inCity.items.every((i) => i.card.kind === 'LISTING')).toBe(true);
    expect(inCity.items.map((i) => i.card.id)).not.toContain(unitIds['O-1']);
  });

  it('[S15-01] development page: an OPEN development by its public code with its live units; private ones never', async () => {
    const code = await codeOf(D.open);
    await websiteApi.portalDevelopment({ locale: 'en', code, requestId: newId() });
    let dev: websiteApi.PortalDevelopment | null = null;
    const statements = await countQueries(async () => {
      dev = await websiteApi.portalDevelopment({ locale: 'en', code: code.toLowerCase(), requestId: newId() });
    });
    expect(statements).toBeLessThanOrEqual(3);
    const shown = dev as websiteApi.PortalDevelopment | null;
    expect(shown?.detail).toMatchObject({
      kind: 'DEVELOPMENT',
      name: `Marina Heights O ${RUN}`,
      units: { total: 3, available: 2, reserved: 1 },
      price: { fromCents: 25_000_000, toCents: 30_000_000 },
    });
    expect(shown?.agency?.id).toBe(b.agencyId);
    // The developer's order (reference), sold units left out.
    expect(shown?.units.map((u) => u.id)).toEqual([unitIds['O-1'], unitIds['O-2'], unitIds['O-3']]);
    expect(JSON.stringify(shown)).not.toMatch(/commission|basisPoints/i);
    const privateCode = await codeOf(D.private);
    // A PRIVATE_NETWORK development is never on the portal (with or without a code).
    const privateShown = privateCode
      ? await websiteApi.portalDevelopment({ locale: 'en', code: privateCode, requestId: newId() })
      : null;
    expect(privateShown).toBeNull();
    expect(await websiteApi.portalDevelopment({ locale: 'en', code: 'nope', requestId: newId() })).toBeNull();
  });

  it('[S15-01] only listed agencies: a suspended agency’s PUBLIC listing and development are nowhere on the portal', async () => {
    websiteApi.resetPortalCaches();
    const page = await searchCity(q({ sort: 'price_asc' }));
    expect(page.items.map((i) => i.card.id)).not.toContain(U.listing);
    // Left out by the query, not after it: the total and the pages agree with the cards.
    expect(page.total).toBe(page.items.length);
    expect(page.total).toBe(3);
    expect(
      await websiteApi.portalListing({ locale: 'en', code: await codeOf(U.listing), requestId: newId() }),
    ).toBeNull();
    expect(
      await websiteApi.portalDevelopment({ locale: 'en', code: await codeOf(D.unlisted), requestId: newId() }),
    ).toBeNull();
    // The listed agencies' stock is still there, and the cached set costs nothing on a warm page.
    expect(await countQueries(() => searchCity())).toBeLessThanOrEqual(3);
  });

  it('[S15-01] a zone or type list past the search limits is cut visibly (reported for the log), never silently', async () => {
    const catalog = await websiteApi.portalCatalog('en');
    const many = Array.from({ length: websiteApi.PORTAL_ZONE_MAX_MEMBERS + 3 }, () => ids.city);
    const filters = websiteApi.portalSearchFilters(catalog, q(), many);
    expect(filters.locationIds).toHaveLength(websiteApi.PORTAL_ZONE_MAX_MEMBERS);
    expect(filters.cut).toEqual({ locations: 3, types: 0 });
    expect(websiteApi.portalSearchFilters(catalog, q(), [ids.city]).cut).toEqual({ locations: 0, types: 0 });
  });
  it('[S15-01] review: owner scope — a hide list that would be cut short falls back to a show list (never unlisted stock)', () => {
    const max = search.MAX_EXCLUDED_OWNERS;
    const names = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}-${i}`);
    // The usual case: a few unlisted owners to hide.
    expect(websiteApi.ownerScopeOf(names(10, 'l'), names(2, 'u'))).toEqual({ hide: names(2, 'u') });
    // More unlisted owners than fit a search, fewer than the listed agencies: never a cut hide list.
    const scope = websiteApi.ownerScopeOf(names(max + 10, 'l'), names(max + 1, 'u'));
    expect('show' in scope && scope.show).toEqual(names(max, 'l'));
    // Fewer listed agencies: shown by name.
    expect(websiteApi.ownerScopeOf(names(3, 'l'), names(max + 1, 'u'))).toEqual({ show: names(3, 'l') });
  });

  it('[S15-01] review: the page gate — a known code’s canonical slug passes unlimited; made-up codes and code-less slugs cost the client’s limit', async () => {
    websiteApi.resetPortalCaches();
    let counted = 0;
    let allow = true;
    const beforeProbe = async () => {
      counted++;
      return allow;
    };
    const listing = (slug: string) => ({ kind: 'listing' as const, locale: 'en', slug });
    const villaCode = await codeOf(L.aVilla);
    const found = await websiteApi.portalListing({ locale: 'en', code: villaCode, requestId: newId() });
    const real = (found?.paths.en ?? '').replace('/en/property/', '');
    expect(real).toMatch(new RegExp(`-${villaCode.toLowerCase()}$`));
    // First sight: counted once and looked up (the page's reads), then remembered: no count, no statement.
    expect(await websiteApi.portalPageCode(listing(real), beforeProbe)).toBe('known');
    expect(counted).toBe(1);
    expect(
      await countQueries(async () => expect(await websiteApi.portalPageCode(listing(real), beforeProbe)).toBe('known')),
    ).toBe(0);
    expect(counted).toBe(1);
    // A development's code is known too (one code table): its canonical slug passes uncounted once looked up.
    const devCode = await codeOf(D.open);
    const devPath = (await websiteApi.portalDevelopment({ locale: 'en', code: devCode, requestId: newId() }))?.paths
      .en as string;
    const dev = { kind: 'development' as const, locale: 'en', slug: devPath.replace('/en/development/', '') };
    expect(await websiteApi.portalPageCode(dev, beforeProbe)).toBe('known');
    counted = 0;
    expect(await websiteApi.portalPageCode(dev, beforeProbe)).toBe('known');
    expect(counted).toBe(0);
    // A made-up code: counted every time (remembered as unknown: no second probe); a slug without a code likewise.
    const madeUp = 'villa-in-town-zzzzzzzz';
    expect(await websiteApi.portalPageCode(listing(madeUp), beforeProbe)).toBe('unknown');
    expect(
      await countQueries(async () =>
        expect(await websiteApi.portalPageCode(listing(madeUp), beforeProbe)).toBe('unknown'),
      ),
    ).toBe(0);
    expect(await websiteApi.portalPageCode(listing('no-code-here'), beforeProbe)).toBe('unknown');
    expect(counted).toBe(3);
    // Over the limit: refused before any probe; a known code's canonical slug still passes.
    allow = false;
    expect(
      await countQueries(async () =>
        expect(await websiteApi.portalPageCode(listing('x-yyyyyyyy'), beforeProbe)).toBe('limited'),
      ),
    ).toBe(0);
    expect(await websiteApi.portalPageCode(listing(real), beforeProbe)).toBe('known');
  });

  it('[S15-01] review: made-up slugs of a real code are counted (each renders its 301) — canonical per kind and locale', async () => {
    websiteApi.resetPortalCaches();
    let counted = 0;
    let allow = true;
    const beforeProbe = async () => {
      counted++;
      return allow;
    };
    const code = (await codeOf(L.aVilla)).toLowerCase();
    const paths = (await websiteApi.portalListing({ locale: 'en', code, requestId: newId() }))?.paths as Record<
      string,
      string
    >;
    const real = (paths.en as string).replace('/en/property/', '');
    expect(await websiteApi.portalPageCode({ kind: 'listing', locale: 'en', slug: real }, beforeProbe)).toBe('known');
    counted = 0;
    // Any other slug of the code: still `known` (its page 301s to the canonical), but counted every time.
    for (const slug of [`a-${code}`, `b-${code}`, `x-${code.toUpperCase()}`]) {
      expect(await websiteApi.portalPageCode({ kind: 'listing', locale: 'en', slug }, beforeProbe), slug).toBe('known');
    }
    expect(counted).toBe(3);
    // The canonical slug is per locale and kind: the English one under Spanish or as a development is counted too.
    expect(await websiteApi.portalPageCode({ kind: 'listing', locale: 'es', slug: real }, beforeProbe)).toBe('known');
    expect(await websiteApi.portalPageCode({ kind: 'development', locale: 'en', slug: real }, beforeProbe)).toBe(
      'known',
    );
    expect(counted).toBe(5);
    // The Spanish canonical slug, once looked up, passes uncounted; the English one still does.
    const es = (paths.es as string).replace('/es/property/', '');
    expect(await websiteApi.portalPageCode({ kind: 'listing', locale: 'es', slug: es }, beforeProbe)).toBe('known');
    counted = 0;
    expect(await websiteApi.portalPageCode({ kind: 'listing', locale: 'es', slug: es }, beforeProbe)).toBe('known');
    expect(await websiteApi.portalPageCode({ kind: 'listing', locale: 'en', slug: real }, beforeProbe)).toBe('known');
    expect(counted).toBe(0);
    // Over the limit, a made-up slug of a real code is refused before any statement.
    allow = false;
    expect(
      await countQueries(async () =>
        expect(await websiteApi.portalPageCode({ kind: 'listing', locale: 'en', slug: `z-${code}` }, beforeProbe)).toBe(
          'limited',
        ),
      ),
    ).toBe(0);
  });
});
