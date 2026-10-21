import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CreateListingBody } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as media from '@inmolink/core/modules/media';
import * as properties from '@inmolink/core/modules/properties';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withSystem, withTenant } from '@inmolink/db';
import { loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { configureStorage, createS3Store, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { containerMemoryEnv } from './container-env';

/**
 * Feed-image memory (S7-F3 acceptance): five `media.importFeedImages` jobs of 20 MB images at once in one worker process
 * stay under 512 MB RSS. Each job streams three images at a time; every image is hashed and uploaded as it arrives
 * (multipart past 8 MiB, through a staging key), never held whole with a concatenated copy. The jobs run in a child
 * process (plain node on the built packages, sized like the `workers` container that runs the `imports` pool); the
 * images come from a loopback origin through `safeFetch`. In the `perf` project: it runs alone.
 *
 * The child calls `media.importFeedImages` directly, so the queue's caps (`IMPORT_IMAGE_JOBS_PER_PROCESS`, 4 by
 * default) are not what limits it here: five jobs at once is one more than a process takes. It runs the built `dist`,
 * so the test first checks that dist is newer than the sources it measures (`pnpm build` otherwise).
 */

const RUN = newId().slice(-8).toLowerCase();
const JOBS = 5;
const LISTINGS_PER_AGENCY = 2;
const IMAGES_PER_LISTING = 3;
/** Just under the feed-image cap (`FEED_IMAGES.MAX_BYTES`, 20 MiB): the worst case a job may download. */
const IMAGE_BYTES = media.FEED_IMAGES.MAX_BYTES - 64 * 1024;
const RSS_BUDGET = 512 * 1024 * 1024;
const run$ = promisify(execFile);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.feedImages', fn);

/** Shared filler; each image starts with the JPEG magic bytes and its own label, so every hash differs. */
const filler = Buffer.alloc(IMAGE_BYTES, 0x5a);
const headerOf = (name: string) => {
  const h = Buffer.alloc(64);
  h.set([0xff, 0xd8, 0xff, 0xe0]);
  h.write(`${RUN}:${name}`, 8);
  return h;
};
const shaOf = (name: string) => createHash('sha256').update(headerOf(name)).update(filler.subarray(64)).digest('hex');

const founders: Founder[] = [];
const names: string[] = [];
let server: Server;
let origin: string;

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  const ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `pfi-${RUN}`,
      translations: [{ locale: 'en', name: `Perf Imagia ${RUN}`, slug: `perf-imagia-${RUN}` }],
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `pfi-g-${RUN}`,
      sort: 0,
      translations: [{ locale: 'en', name: `Perf Image Houses ${RUN}`, slug: `pfi-houses-${RUN}` }],
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `pfi-t-${RUN}`,
      sort: 0,
      translations: [{ locale: 'en', name: `Perf Image Villa ${RUN}`, slug: `pfi-villa-${RUN}` }],
    });
    return { location, type };
  });

  server = createServer(async (req, res) => {
    const name =
      (req.url ?? '')
        .split('/')
        .at(-1)
        ?.replace(/\.jpg$/, '') ?? '';
    // No length: the worker cannot size anything up front.
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.write(headerOf(name));
    for (let at = 64; at < IMAGE_BYTES; at += 65_536) {
      if (!res.write(filler.subarray(at, Math.min(at + 65_536, IMAGE_BYTES)))) await once(res, 'drain');
    }
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (let j = 0; j < JOBS; j++) {
    const founder = await createFounder();
    founders.push(founder);
    const queued: { listingId: string; urls: string[] }[] = [];
    for (let l = 0; l < LISTINGS_PER_AGENCY; l++) {
      const listing = await withMemberCtx(
        { userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' },
        (ctx) =>
          properties.createListing(
            ctx,
            CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location }),
          ),
      );
      const urls = Array.from({ length: IMAGES_PER_LISTING }, (_, i) => {
        const name = `j${j}-l${l}-i${i}`;
        names.push(name);
        return `${origin}/${RUN}/${name}.jpg`;
      });
      queued.push({ listingId: listing.id, urls });
    }
    await withTenant({ agencyId: founder.agencyId }, (tx) => media.queueFeedImages(tx, founder.agencyId, queued));
  }
}, 300_000);

afterAll(async () => {
  server?.close();
  await Promise.all(names.map((n) => storage().delete('work', media.originalKey(shaOf(n)))));
  for (const founder of founders) {
    await system((tx) => tx.execute(sql`delete from feed_image_queue where agency_id = ${founder.agencyId}`));
  }
  await closeDb();
});

/** Newest modification time of the non-test sources under `dir`. */
function newestSource(dir: string): number {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.includes('__tests__') && !f.endsWith('.test.ts'))
    .reduce((t, f) => Math.max(t, statSync(join(dir, f)).mtimeMs), 0);
}

const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;

it('[S7-F3] five feed-image jobs of 20 MB images in one worker process stay under 512 MB RSS', async () => {
  const root = join(import.meta.dirname, '..', '..');
  for (const [dist, src] of [
    ['packages/core/dist/modules/media/index.js', 'packages/core/src/modules/media'],
    ['packages/platform/dist/storage/index.js', 'packages/platform/src/storage'],
  ] as const) {
    // a stale build would measure old code: run `pnpm build` (turbo builds before the perf project in CI)
    expect(statSync(join(root, dist)).mtimeMs, `${dist} older than ${src}`).toBeGreaterThanOrEqual(
      newestSource(join(root, src)),
    );
  }
  const { stdout } = await run$(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      join(import.meta.dirname, 'feed-images.child.ts'),
      JSON.stringify({ agencies: founders.map((f) => f.agencyId), origin }),
    ],
    {
      encoding: 'utf8',
      timeout: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...containerMemoryEnv('workers'), APP_ROLE: 'worker' },
    },
  );
  const lines = stdout.trim().split('\n');
  for (const line of lines.slice(0, -1)) console.warn(line.slice(0, 2_000));
  const result = JSON.parse(lines.at(-1) as string) as {
    base: number;
    peak: number;
    maxRss: number;
    ms: number;
    arrayBuffers: number;
    heapUsed: number;
    results: media.FeedImagesResult[];
  };
  const images = JOBS * LISTINGS_PER_AGENCY * IMAGES_PER_LISTING;
  console.info(
    `[S7-F3] ${JOBS} jobs, ${images} images of ${mb(IMAGE_BYTES)} in ${(result.ms / 1000).toFixed(1)} s; child RSS ` +
      `idle ${mb(result.base)}, peak ${mb(result.peak)} (buffers ${mb(result.arrayBuffers)}, heap ${mb(result.heapUsed)}), ` +
      `maxRSS ${mb(result.maxRss)}`,
  );
  for (const r of result.results) {
    expect(r).toMatchObject({
      listings: LISTINGS_PER_AGENCY,
      downloaded: LISTINGS_PER_AGENCY * IMAGES_PER_LISTING,
      failed: 0,
      attached: LISTINGS_PER_AGENCY * IMAGES_PER_LISTING,
      more: false,
    });
  }
  // every file under its content-addressed key; no staging object left
  const heads = await Promise.all(names.map((n) => storage().head('work', media.originalKey(shaOf(n)))));
  expect(heads.every((h) => h?.sizeBytes === IMAGE_BYTES)).toBe(true);
  expect((await storage().list('work', media.FEED_STAGING_PREFIX, { limit: 10 })).objects).toEqual([]);
  expect(Math.max(result.peak, result.maxRss)).toBeLessThan(RSS_BUDGET);
}, 900_000);
