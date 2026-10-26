import { CreateListingBody, PortalQuery, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../index';

/**
 * Agency profile pages (S15-03): a listed agency's public profile (directory name, published contacts, register number,
 * languages, town, its texts per locale) and its PUBLIC listings through the portal search — never an unlisted
 * agency's, never anything the agency did not publish — within the page budget.
 */

const RUN = newId().slice(-8).toLowerCase();
const slug = (s: string) => `${s}-pa-${RUN}`;

let a: Founder;
let b: Founder;
/** Verified, published, then suspended: off the directory. */
let gone: Founder;
/** Signed up, never verified: never in the directory. */
let pending: Founder;
const L = { aVilla: '', aFlat: '', aShared: '', bVilla: '', gone: '' };
let ids: { city: string; villa: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function listing(m: Founder, priceCents: number, visibility: 'PUBLIC' | 'SHARED' = 'PUBLIC'): Promise<string> {
  const { id } = await as(m, (ctx) =>
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
  );
  await as(m, async (ctx) =>
    properties.saveListingTranslation(ctx, id, 'en', {
      version: (await properties.getListing(ctx, id)).version,
      title: `Home ${RUN}`,
      description: 'A bright home near the sea.',
    }),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility,
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  return id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:portal-agencies:${RUN}` });
  taxonomy.dropLocalTaxonomyCopies();
  websiteApi.resetPortalCaches();
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  // The engine is unreachable: the Postgres fallback answers (the budget's worst case).
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  a = await createFounder({ companyName: `Profile Homes ${RUN}` });
  b = await createFounder({ companyName: `Other Homes ${RUN}` });
  gone = await createFounder({ companyName: `Gone Homes ${RUN}` });
  pending = await createFounder({ companyName: `Pending Homes ${RUN}` });
  for (const m of [a, b, gone]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await withSystem('portal-agencies.test', async (tx) => {
    const name = (n: string, s: string) => [
      { locale: 'en', name: `${n} ${RUN}`, slug: slug(s) },
      { locale: 'es', name: `${n} ${RUN}`, slug: slug(`${s}-es`) },
    ];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: slug('c'),
      translations: name('Profiland', 'profiland'),
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
      translations: name('Puerto', 'puerto'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: slug('houses'),
      sort: 0,
      translations: name('Houses', 'houses'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: slug('villa'),
      sort: 0,
      translations: name('Villa', 'villa'),
    });
    // What agency A states and publishes: company facts (register, languages, town; the tax id and address are set
    // too and must never show), its public contacts, its texts in English and Spanish.
    await tx.execute(sql`update agencies set register_number = 'AICAT-4711', languages = '{es,en,de}', city = 'Puerto',
      tax_id = 'B12345674', address_line = 'Calle Secreta 9', postal_code = '03181' where agency_id = ${a.agencyId}`);
    await tx.execute(sql`insert into agency_profiles (agency_id, contact_email, contact_phone, website_url)
      values (${a.agencyId}, 'hola@profile.example', '+34 600 000 000', 'https://profile.example')
      on conflict (agency_id) do update set contact_email = excluded.contact_email,
        contact_phone = excluded.contact_phone, website_url = excluded.website_url`);
    await tx.execute(sql`insert into agency_translations (agency_id, locale, tagline, description) values
      (${a.agencyId}, 'en', 'Homes by the sea', 'We sell homes on the coast.'),
      (${a.agencyId}, 'es', 'Casas junto al mar', 'Vendemos casas en la costa.')`);
    await tx.execute(sql`update agencies set register_number = 'GONE-1' where agency_id = ${gone.agencyId}`);
    return { city, villa };
  });
  L.aVilla = await listing(a, 40_000_000);
  L.aFlat = await listing(a, 15_000_000);
  L.aShared = await listing(a, 20_000_000, 'SHARED');
  L.bVilla = await listing(b, 90_000_000);
  L.gone = await listing(gone, 33_000_000);
  await withSystem('portal-agencies.test', (tx) => search.rebuildReadModels(tx, 'LISTING', Object.values(L)));
  await setAgencyStatus(gone.agencyId, 'SUSPENDED');
  websiteApi.resetPortalCaches();
}, 180_000);

afterAll(async () => {
  await closeCache();
  await closeDb();
});

const agencyListings = (agencyId: string, query = PortalQuery.parse({})) =>
  websiteApi.portalSearch({ locale: 'en', agencyId, query, requestId: newId() });

describe('portal agency profiles (S15-03)', () => {
  it('[S15-03] a listed agency’s profile: published contacts, register number, languages, town and its texts per locale', async () => {
    const en = await websiteApi.portalAgency('en', a.agencyId);
    expect(en).toMatchObject({
      id: a.agencyId,
      name: expect.stringContaining(`Profile Homes ${RUN}`),
      kind: 'AGENCY',
      email: 'hola@profile.example',
      phone: '+34 600 000 000',
      website: 'https://profile.example',
      registerNumber: 'AICAT-4711',
      languages: ['es', 'en', 'de'],
      city: 'Puerto',
      tagline: 'Homes by the sea',
      description: 'We sell homes on the coast.',
      textLocale: 'en',
    });
    const es = await websiteApi.portalAgency('es', a.agencyId.toUpperCase());
    expect(es).toMatchObject({ id: a.agencyId, tagline: 'Casas junto al mar', textLocale: 'es' });
    // One URL per locale, named once (the directory name), the same in both answers.
    expect(en?.paths).toEqual(websiteApi.portalAgencyPaths({ id: a.agencyId, name: en?.name ?? '' }));
    expect(en?.paths.en).toBe(`/en/agency/${a.agencyId}/profile-homes-${RUN}`);
    expect(es?.paths).toEqual(en?.paths);
    // Nothing the agency did not publish: no tax id, address, postal code, commission, members or settings.
    const json = JSON.stringify(en);
    for (const secret of ['B12345674', 'Calle Secreta', '03181', 'commission', a.email]) {
      expect(json.includes(secret), secret).toBe(false);
    }
    // An agency without texts or contacts still has its page.
    expect(await websiteApi.portalAgency('en', b.agencyId)).toMatchObject({
      id: b.agencyId,
      email: null,
      tagline: null,
      description: null,
      textLocale: null,
      registerNumber: null,
    });
  });

  it('[S15-03] only directory-listed agencies have a page: unverified, suspended, unknown or malformed ids answer none', async () => {
    expect(await websiteApi.portalAgency('en', pending.agencyId)).toBeNull();
    expect(await websiteApi.portalAgency('en', gone.agencyId)).toBeNull();
    expect(await websiteApi.portalAgency('en', newId())).toBeNull();
    expect(await websiteApi.portalAgency('en', 'not-an-id')).toBeNull();
    expect(await websiteApi.portalAgency('en', `${a.agencyId}' or 1=1 --`)).toBeNull();
    // And none of their stock either.
    expect((await agencyListings(gone.agencyId)).items).toEqual([]);
    expect((await agencyListings(pending.agencyId)).total).toBe(0);
  });

  it('[S15-03] the profile lists only the agency’s own PUBLIC listings, as the search’s cards', async () => {
    const page = await agencyListings(a.agencyId);
    expect(page.items.map((i) => i.card.id).sort()).toEqual([L.aVilla, L.aFlat].sort());
    expect(page.total).toBe(2);
    expect(page.pageCount).toBe(1);
    // The same card the search shows: its code, the agency named (its profile's own published details).
    for (const item of page.items) {
      expect(item.code).toMatch(/^[0-9A-Z]{8}$/);
      expect(item.agency).toMatchObject({ id: a.agencyId, email: 'hola@profile.example' });
    }
    // Sorted and paged like every search (`?page=N`): a page past the last is empty.
    const cheap = await agencyListings(a.agencyId, PortalQuery.parse({ sort: 'price_asc' }));
    expect(cheap.items.map((i) => i.card.id)).toEqual([L.aFlat, L.aVilla]);
    const past = await agencyListings(a.agencyId, PortalQuery.parse({ page: '2' }));
    expect(past.items).toEqual([]);
    expect(past.page).toBe(2);
  });

  it('[S15-03] budget: a profile page ≤ 3 statements cold, the profile read cached', async () => {
    websiteApi.resetPortalCaches();
    // Warm the owner scope (cached for a minute in every portal page).
    await websiteApi.portalSearch({ locale: 'en', query: PortalQuery.parse({}), requestId: newId() });
    const cold = await countQueries(async () => {
      await websiteApi.portalAgency('en', a.agencyId);
      await agencyListings(a.agencyId);
    });
    expect(cold).toBeLessThanOrEqual(3);
    expect(await countQueries(() => websiteApi.portalAgency('en', a.agencyId))).toBe(0);
    // A miss is remembered too (its own small cache: made-up ids never evict real profiles); a malformed id costs none.
    const unknown = newId();
    expect(await countQueries(() => websiteApi.portalAgency('en', unknown))).toBe(1);
    expect(await countQueries(() => websiteApi.portalAgency('en', unknown))).toBe(0);
    expect(await countQueries(() => websiteApi.portalAgency('en', 'nope'))).toBe(0);
    // The listings of an agency without a listed profile cost no search (defence in depth beside the owner scope).
    expect(await countQueries(() => agencyListings(pending.agencyId))).toBeLessThanOrEqual(1);
  });
});
