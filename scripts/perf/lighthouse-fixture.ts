// The local `pnpm perf:lighthouse` fixture (S7-F8): a verified agency with an IFRAME site showing its own and a
// network agency's listings, in the docker `test` stack. Test agencies are pruned after 6 h (`setupTestDb`). The
// listings have photos: WebP variants of the media pipeline's sizes in the test MinIO's public media bucket, set on
// their read models as processed images (the media pipeline itself is not part of this measurement).
import { CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, type Founder, withSystem } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { configureStorage, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';

const DESCRIPTION = [
  'A bright villa a short walk from the beach, with sea views from the terrace and the main bedroom.',
  'The ground floor opens onto a garden with a private pool; the kitchen is fitted and the living room has a fireplace.',
  'Upstairs, three bedrooms share two bathrooms. Parking for two cars, storage room and air conditioning throughout.',
].join('\n\n');

export async function seedEmbedFixture(): Promise<{ siteId: string; ref: string; close: () => Promise<void> }> {
  const run = newId().slice(-8);
  await setupTestDb('worker');
  await configureCache({ prefix: `perf:lighthouse:${run}` });
  const [a, b] = [await createFounder({ companyName: `Lighthouse Homes ${run}` }), await createFounder()];
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const ids = await withSystem('perf.lighthouse', async (tx) => {
    const name = (n: string) => [
      { locale: 'en', name: n, slug: `${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-lh-${run.toLowerCase()}` },
    ];
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
  return {
    siteId: site.id,
    ref,
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
