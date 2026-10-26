// The local `pnpm perf:lighthouse` fixture (S7-F8): a verified agency with an IFRAME site showing its own and a
// network agency's listings, in the docker `test` stack. Test agencies are pruned after 6 h (`setupTestDb`). The
// listings have photos: WebP variants of the media pipeline's sizes in the test MinIO's public media bucket, set on
// their read models as processed images (the media pipeline itself is not part of this measurement).
import {
  CreateDevelopmentBody,
  CreateListingBody,
  CreateUnitsBody,
  SetDevelopmentAccessBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as developments from '@inmolink/core/modules/developments';
import * as presentations from '@inmolink/core/modules/presentations';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, type Founder, withSystem } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { cache, closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { configureStorage, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { testStackEnv } from '../../tests/e2e/stack';

const DESCRIPTION = [
  'A bright villa a short walk from the beach, with sea views from the terrace and the main bedroom.',
  'The ground floor opens onto a garden with a private pool; the kitchen is fitted and the living room has a fireplace.',
  'Upstairs, three bedrooms share two bathrooms. Parking for two cars, storage room and air conditioning throughout.',
].join('\n\n');

export async function seedEmbedFixture(): Promise<{
  siteId: string;
  ref: string;
  selectionPath: string;
  /** S15-01: the portal's location page (country / region / city) and a listing page of the fixture; S15-03 its
   * agency's profile page. */
  portal: {
    searchPath: string;
    locationPath: string;
    listingPath: string;
    developmentPath: string;
    agencyPath: string;
  };
  close: () => Promise<void>;
}> {
  const run = newId().slice(-8);
  await setupTestDb('worker');
  await configureCache({ prefix: `perf:lighthouse:${run}` });
  const [a, b] = [await createFounder({ companyName: `Lighthouse Homes ${run}` }), await createFounder()];
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const name = (n: string) => [
    { locale: 'en', name: n, slug: `${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-lh-${run.toLowerCase()}` },
  ];
  const ids = await withSystem('perf.lighthouse', async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `lh-${run}`,
      translations: name('Spain'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: `lh-r-${run}`,
      translations: name('Costa del Sol'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: `lh-c-${run}`,
      translations: name('Marbella'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `lh-g-${run}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `lh-v-${run}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { country, city, villa };
  });
  // S15-01: the public app reads the taxonomy through the shared cache (an hour): drop its copies from before these
  // places existed, under the app's own keys (no worker runs here to do it on the taxonomy event).
  await closeCache();
  await configureCache({ url: testStackEnv().REDIS_CACHE_URL });
  await cache.invalidateTag('taxonomy');
  await closeCache();
  await configureCache({ prefix: `perf:lighthouse:${run}` });
  const as = <T>(m: Founder, fn: Parameters<typeof withMemberCtx<T>>[1]) =>
    withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
  const listing = async (m: Founder, i: number) => {
    const { id } = await as(m, (ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 45_000_000 + i * 2_500_000,
          energyRating: 'B',
          bedrooms: 3,
          bathrooms: 2,
        }),
      ),
    );
    await as(m, async (ctx) =>
      properties.saveListingTranslation(ctx, id, 'en', {
        version: (await properties.getListing(ctx, id)).version,
        title: `Villa with sea views ${i + 1}`,
        description: DESCRIPTION,
      }),
    );
    await as(m, async (ctx) =>
      properties.updateListing(
        ctx,
        id,
        UpdateListingBody.parse({
          status: 'ACTIVE',
          visibility: 'PUBLIC',
          shareScope: 'ALL',
          version: (await properties.getListing(ctx, id)).version,
        }),
      ),
    );
    return id;
  };
  const listingIds: string[] = [];
  for (let i = 0; i < 6; i++) listingIds.push(await listing(i % 2 === 0 ? a : b, i));
  await withSystem('perf.lighthouse', (tx) => search.rebuildReadModels(tx, 'LISTING', listingIds));
  await addPhotos(run, listingIds);
  const site = await as(a, (ctx) =>
    websites.createSite(ctx, {
      name: 'Lighthouse embed',
      domains: ['www.lighthouse-homes.example'],
      mode: 'IFRAME',
      inventoryPolicy: 'CUSTOM',
      inventoryFilters: {
        includeOwn: true,
        includeNetwork: true,
        locationIds: [ids.country],
        propertyTypeIds: [],
        newBuilds: true,
      },
      referencePrefix: 'LH',
      locales: ['en', 'es'],
      contact: { name: 'Lighthouse Homes', email: 'hello@lighthouse-homes.example', phone: '+34 600 000 123' },
    }),
  );
  const ref = (await as(a, (ctx) => properties.getListing(ctx, listingIds[0] as string))).ref as string;
  // The key the public app (same test env) hashes and looks the token up with.
  presentations.configurePresentations({ tokenKey: testStackEnv().HMAC_KEY as string });
  // S13-F13: a selection of own and network listings, as its public page `/s/<token>` shows it.
  const selection = await as(a, (ctx) =>
    presentations.createSelection(ctx, {
      title: 'Villas for you',
      message: 'A few homes I think you will like.',
      locale: 'en',
      items: listingIds.slice(0, 4).map((targetId) => ({ targetId })),
    }),
  );
  // S15-01: the portal's pages of the same listings (location slugs as `name()` makes them; codes from the rebuild).
  const slug = (n: string) => name(n)[0]?.slug as string;
  const code = (await withSystem('perf.lighthouse', (tx) => search.publicCodes(tx, [listingIds[0] as string]))).get(
    listingIds[0] as string,
  );
  if (!code) throw new Error('lighthouse fixture: the listing has no public code');
  // S15-01: an OPEN development with a few units in Marbella (its page lists them).
  const dev = await as(a, (ctx) =>
    developments.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({
        ref: `LH-DEV-${run}`,
        name: 'Marina Heights',
        status: 'UNDER_CONSTRUCTION',
        completionDate: '2027-06-30',
        locationId: ids.city,
        commission: { type: 'PCT', basisPoints: 400, includesVat: false },
      }),
    ),
  );
  await as(a, (ctx) =>
    developments.setDevelopmentAccess(
      ctx,
      dev.id,
      SetDevelopmentAccessBody.parse({ version: dev.version, kind: 'OPEN', allowedAgencyIds: [] }),
    ),
  );
  const units = await as(a, (ctx) =>
    developments.createUnits(
      ctx,
      dev.id,
      CreateUnitsBody.parse({
        units: Array.from({ length: 8 }, (_, i) => ({
          ref: `A-${i + 1}-${run}`,
          status: i === 3 ? 'RESERVED' : 'AVAILABLE',
          priceCents: 32_000_000 + i * 1_500_000,
          bedrooms: 1 + (i % 3),
          bathrooms: 1 + (i % 2),
          propertyTypeId: ids.villa,
        })),
      }),
    ),
  );
  await withSystem('perf.lighthouse', (tx) =>
    search.rebuildReadModels(
      tx,
      'UNIT',
      units.items.map((u) => u.id),
    ),
  );
  const devCode = (await withSystem('perf.lighthouse', (tx) => search.publicCodes(tx, [dev.id]))).get(dev.id);
  if (!devCode) throw new Error('lighthouse fixture: the development has no public code');
  // S15-03: what agency A publishes on its profile page (contacts, register number, languages, its texts).
  await withSystem('perf.lighthouse', async (tx) => {
    await tx.execute(sql`update agencies set register_number = 'AICAT-4711', languages = '{es,en}', city = 'Marbella'
      where agency_id = ${a.agencyId}`);
    await tx.execute(sql`insert into agency_profiles (agency_id, contact_email, contact_phone, website_url)
      values (${a.agencyId}, 'hola@lighthouse.example', '+34 600 000 000', 'https://lighthouse.example')
      on conflict (agency_id) do nothing`);
    await tx.execute(sql`insert into agency_translations (agency_id, locale, tagline, description)
      values (${a.agencyId}, 'en', 'Homes on the Costa del Sol since 1998', ${DESCRIPTION})
      on conflict do nothing`);
  });
  return {
    siteId: site.id,
    ref,
    selectionPath: selection.share.path,
    portal: {
      searchPath: '/en/properties',
      locationPath: `/en/properties/${slug('Spain')}/${slug('Costa del Sol')}/${slug('Marbella')}`,
      listingPath: `/en/property/villa-in-marbella-${code.toLowerCase()}`,
      developmentPath: `/en/development/marina-heights-${devCode.toLowerCase()}`,
      agencyPath: websiteApi.agencyPath('en', a.agencyId, `Lighthouse Homes ${run}`),
    },
    close: async () => {
      await closeCache();
      await closeDb();
    },
  };
}

/** The media pipeline's WebP sizes (longest side; `media/variants.ts`). */
const SIZES = { thumb: 320, small: 640, medium: 1280, large: 2048 } as const;
const PHOTOS = 4;

/** A photo-like image (a gradient with soft noise, so WebP sizes are realistic) at each variant size. */
async function photo(seed: number, width: number): Promise<Uint8Array> {
  const height = Math.round((width * 2) / 3);
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const n = ((x * 7919 + y * 104729 + seed * 31) % 23) - 11;
      raw[i] = Math.max(0, Math.min(255, 40 + ((x * 180) / width + seed * 30) + n));
      raw[i + 1] = Math.max(0, Math.min(255, 90 + (y * 120) / height + n));
      raw[i + 2] = Math.max(0, Math.min(255, 160 - (x * 60) / width + n));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .webp({ quality: 75 })
    .toBuffer();
}

/** Uploads the photos' variants and puts them on the listings' read models (cover on the card, gallery on the detail). */
async function addPhotos(run: string, listingIds: readonly string[]): Promise<void> {
  configureStorage(storageConfigFromEnv(process.env as Parameters<typeof storageConfigFromEnv>[0]));
  const keys: Record<string, string>[] = [];
  for (let p = 0; p < PHOTOS; p++) {
    const variants: Record<string, string> = {};
    for (const [size, width] of Object.entries(SIZES)) {
      const key = `v1/lighthouse-${run.toLowerCase()}-${p}/${size}.webp`;
      await storage().put('media', key, await photo(p, width), {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      variants[size] = key;
    }
    keys.push(variants);
  }
  const image = (p: number, cover: boolean) => ({
    kind: 'IMAGE',
    cover,
    alt: null,
    room: null,
    width: 2048,
    height: 1365,
    variants: keys[p % PHOTOS],
  });
  for (const [n, id] of listingIds.entries()) {
    const cover = image(n, true);
    const media = Array.from({ length: PHOTOS }, (_, p) => image(n + p, p === 0));
    await withSystem('perf.lighthouse', (tx) =>
      tx.execute(sql`update listing_read_models
        set card = card || jsonb_build_object('cover', ${JSON.stringify(cover)}::jsonb, 'imageCount', ${PHOTOS}::int),
            detail = detail || jsonb_build_object('cover', ${JSON.stringify(cover)}::jsonb, 'imageCount', ${PHOTOS}::int,
              'media', ${JSON.stringify(media)}::jsonb)
        where target_id = ${id}`),
    );
  }
}
