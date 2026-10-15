import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CreateListingBody, MediaCheckBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue, queueFor } from '@inmolink/platform/queue';
import { type BucketName, configureStorage, createMemoryStore, type MemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as media from '../index';

/**
 * Media processing worker on the real database (S3-04). Storage is this process's memory store: Vitest runs
 * each file in its own fork, so the originals sweep here never sees the MinIO objects of a parallel suite (the
 * MinIO path runs in `tests/perf/media-processing.int.test.ts`). Queues live under this run's Redis prefix.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const log = createLogger({ service: 'test', level: 'silent' });
const DAY = 86_400_000;

type UploadType = 'image/jpeg' | 'image/heic' | 'image/png';

let store: MemoryStore;
let founder: Founder;
let listingId: string;

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('media.processing.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);
const jobCtx = () => ({
  log,
  jobId: newId(),
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

/** A photo unique to this run: a gradient, shapes and this run's id as text. */
const photo = (label: string, width = 1600, height = 1200) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 800 600">
        <defs><linearGradient id="g"><stop offset="0" stop-color="#264653"/><stop offset="1" stop-color="#e9c46a"/></linearGradient></defs>
        <rect width="800" height="600" fill="url(#g)"/><rect x="220" y="260" width="360" height="280" fill="#e76f51"/>
        <text x="40" y="80" font-size="48" fill="#fff">${RUN} ${label}</text></svg>`,
    ),
  );

/** What a verified upload leaves: the original under its content key, in the private bucket. */
async function stored(bytes: Uint8Array, contentType: UploadType) {
  const hash = sha(bytes);
  await store.put('private', media.originalKey(hash), bytes, { contentType });
  return { sha256: hash, upload: { sizeBytes: bytes.byteLength, contentType } };
}

const processObject = (p: {
  sha256: string;
  upload?: { sizeBytes: number; contentType: UploadType } | null;
  sizes?: media.VariantName[];
}) =>
  media.mediaJobs.processObject.spec.run(
    { sha256: p.sha256, agencyId: founder.agencyId, upload: p.upload ?? null, sizes: p.sizes, trigger: newId() },
    jobCtx(),
  );
const prune = () => media.mediaJobs.pruneOrphans.spec.run({}, jobCtx()) as Promise<Record<string, number>>;

const bytesAt = (bucket: BucketName, key: string) => store.objects.get(`${bucket}/${key}`)?.body ?? null;
const original = (hash: string) => bytesAt('private', media.originalKey(hash));
const master = (hash: string) => bytesAt('private', media.masterKey(hash));
const variantBytes = (hash: string) =>
  Object.fromEntries(media.VARIANT_NAMES.map((n) => [n, bytesAt('media', media.variantKey(hash, n))]));
const objectRow = async (hash: string) =>
  (
    await rows<{
      pipeline: number | null;
      variants_ready: number;
      width: number;
      height: number;
      phash: string | null;
      failed: boolean;
    }>(
      sql`select pipeline, variants_ready, width, height, phash::text, failed_at is not null as failed
            from media_objects where sha256 = ${hash}`,
    )
  )[0] ?? null;
const attach = (hash: string) =>
  system((tx) =>
    tx.execute(sql`insert into property_media (id, property_id, agency_id, sha256, position)
                   values (${newId()}, ${listingId}, ${founder.agencyId}, ${hash},
                           (select count(*) from property_media where property_id = ${listingId}))`),
  );
/** `media.processObject` jobs of this run's queue for one object. */
const queuedFor = async (hash: string) =>
  (await queueFor('media').getJobs(['waiting', 'prioritized', 'delayed'])).filter(
    (j) => j.name === 'media.processObject' && JSON.stringify(j.data).includes(hash),
  );

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureQueue({ prefix: `test-media-${RUN}`, logger: log });
  store = createMemoryStore();
  configureStorage(store);
  media.configureMedia({ urlKey: `media-test-key-${RUN}-0123456789abcdef` });
  founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  const ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('pc'),
      translations: tr(`Processland ${RUN}`, 'processland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('p-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'p-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('p-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'p-villa'),
    });
    return { location, type };
  });
  listingId = (
    await as((ctx) =>
      properties.createListing(ctx, CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location })),
    )
  ).id;
}, 120_000);

afterAll(async () => {
  await queueFor('media').obliterate({ force: true });
  await closeQueues();
  await closeDb();
});

describe('media processing worker', () => {
  it('[S3-04] variants are byte-identical when regenerated with the same pipeline version', async () => {
    const upload = await stored(await photo('identical').jpeg({ quality: 90 }).toBuffer(), 'image/jpeg');
    await processObject(upload);
    const first = variantBytes(upload.sha256);
    const firstMaster = master(upload.sha256);
    expect(firstMaster).not.toBeNull();
    expect(Object.values(first).every((b) => b !== null)).toBe(true);
    expect(await objectRow(upload.sha256)).toMatchObject({
      pipeline: media.MEDIA_PIPELINE_VERSION,
      variants_ready: media.ALL_VARIANTS_MASK,
      width: 1600,
      height: 1200,
    });

    // On demand: two sizes lost — rendered again from the master (the original is gone), same bytes.
    for (const n of ['thumb', 'og'] as const) await store.delete('media', media.variantKey(upload.sha256, n));
    await system((tx) =>
      tx.execute(sql`update media_objects set variants_ready = variants_ready & ~17 where sha256 = ${upload.sha256}`),
    );
    expect(await processObject({ sha256: upload.sha256, sizes: ['thumb', 'og'] })).toEqual({ made: 2 });
    expect(variantBytes(upload.sha256)).toEqual(first);
    expect((await objectRow(upload.sha256))?.variants_ready).toBe(media.ALL_VARIANTS_MASK);
    // Nothing missing: nothing made.
    expect(await processObject({ sha256: upload.sha256, sizes: ['thumb'] })).toEqual({ made: 0 });

    // From scratch (same original uploaded again, every file lost): the same master and variants.
    await stored(await photo('identical').jpeg({ quality: 90 }).toBuffer(), 'image/jpeg');
    await store.delete('private', media.masterKey(upload.sha256));
    for (const n of media.VARIANT_NAMES) await store.delete('media', media.variantKey(upload.sha256, n));
    await system((tx) =>
      tx.execute(sql`update media_objects set pipeline = null, variants_ready = 0 where sha256 = ${upload.sha256}`),
    );
    await processObject({ sha256: upload.sha256 });
    expect(master(upload.sha256)).toEqual(firstMaster);
    expect(variantBytes(upload.sha256)).toEqual(first);
  });

  it('[S3-04] the master is normalized: orientation applied, EXIF and GPS stripped, ≤ 2560 px; the original is deleted', async () => {
    const withExif = await photo('exif', 3200, 2400)
      .jpeg({ quality: 90 })
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Copyright: 'Owner Agency', Artist: 'Seller name' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '36/1 30/1 0/1' },
      })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const upload = await stored(withExif, 'image/jpeg');
    await processObject(upload);

    const meta = await sharp(master(upload.sha256) ?? undefined).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 1920, height: 2560 });
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    for (const n of media.VARIANT_NAMES) {
      const bytes = bytesAt('media', media.variantKey(upload.sha256, n));
      expect((await sharp(bytes ?? undefined).metadata()).exif).toBeUndefined();
    }
    expect(await objectRow(upload.sha256)).toMatchObject({ width: 1920, height: 2560, phash: expect.any(String) });
    // Only variants are ever served: the original (with its EXIF) is not kept, the master is private.
    expect(original(upload.sha256)).toBeNull();
    expect(bytesAt('media', media.masterKey(upload.sha256))).toBeNull();
    // Variant keys never expose the content hash.
    expect(media.variantKey(upload.sha256, 'large')).not.toContain(upload.sha256);
    expect(media.variantKey(upload.sha256, 'large')).toMatch(/^v1\/[0-9a-f]{32}\/large\.webp$/);
  });

  it('[S3-04] HEIC uploads are converted to WebP', async () => {
    const heic = new Uint8Array(readFileSync(new URL('./fixtures/gradient.heic', import.meta.url)));
    // A unique hash per run: the same pixels, a few trailing bytes the decoder ignores.
    const bytes = new Uint8Array(heic.byteLength + RUN.length);
    bytes.set(heic);
    bytes.set(new TextEncoder().encode(RUN), heic.byteLength);
    const upload = await stored(bytes, 'image/heic');
    await processObject(upload);
    expect(await sharp(master(upload.sha256) ?? undefined).metadata()).toMatchObject({
      format: 'webp',
      width: 640,
      height: 480,
    });
    expect(
      await sharp(bytesAt('media', media.variantKey(upload.sha256, 'small')) ?? undefined).metadata(),
    ).toMatchObject({ format: 'webp', width: 640 });
    expect((await objectRow(upload.sha256))?.variants_ready).toBe(media.ALL_VARIANTS_MASK);
  });

  it('[S3-04] a file that cannot be processed is given up: original deleted, check asks for a fresh upload', async () => {
    // Bytes that do not match their key: dropped with their record (nothing uses them).
    const real = await photo('tampered').png().toBuffer();
    const hash = sha(real);
    await store.put('private', media.originalKey(hash), await photo('other').png().toBuffer(), {
      contentType: 'image/png',
    });
    await expect(
      processObject({ sha256: hash, upload: { sizeBytes: real.byteLength, contentType: 'image/png' } }),
    ).rejects.toThrow(/does not match/);
    expect(original(hash)).toBeNull();
    expect(master(hash)).toBeNull();
    expect(await objectRow(hash)).toBeNull();

    // A JPEG header over junk, already used by a listing: kept as failed, its original deleted.
    const junk = new Uint8Array(8_192).fill(0x41);
    junk.set([0xff, 0xd8, 0xff, 0xe0]);
    junk.set(new TextEncoder().encode(RUN), 16);
    const bad = await stored(junk, 'image/jpeg');
    await attach(bad.sha256);
    await expect(processObject(bad)).rejects.toThrow(/not readable/);
    expect(await objectRow(bad.sha256)).toMatchObject({ pipeline: null, failed: true });
    expect(original(bad.sha256)).toBeNull();
    const checked = await as((ctx) =>
      media.checkUploads(
        ctx,
        MediaCheckBody.parse({
          files: [{ sha256: bad.sha256, sizeBytes: junk.byteLength, contentType: 'image/jpeg' }],
        }),
      ),
    );
    expect(checked.files[0]?.status).toBe('UPLOAD');
  });

  it('[S3-04] orphaned objects older than the grace period are deleted; referenced objects never are', async () => {
    const orphan = await stored(await photo('orphan').jpeg().toBuffer(), 'image/jpeg');
    const referenced = await stored(await photo('referenced').jpeg().toBuffer(), 'image/jpeg');
    const recent = await stored(await photo('recent').jpeg().toBuffer(), 'image/jpeg');
    for (const x of [orphan, referenced, recent]) await processObject(x);
    const [o, r, n] = [orphan.sha256, referenced.sha256, recent.sha256];
    // `referenced` is used by a listing although its stored count says 0 and its grace period passed: the
    // cleanup counts again and keeps it.
    await attach(r);
    await system(async (tx) => {
      await tx.execute(sql`update media_objects set refcount = 0, delete_after = now() - interval '1 hour'
                            where sha256 in (${o}, ${r})`);
      await tx.execute(sql`update media_objects set refcount = 0, delete_after = now() + interval '6 days'
                            where sha256 = ${n}`);
    });

    const result = await prune();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await objectRow(o)).toBeNull();
    expect(master(o)).toBeNull();
    expect(Object.values(variantBytes(o)).every((b) => b === null)).toBe(true);

    expect(await rows(sql`select refcount, delete_after from media_objects where sha256 = ${r}`)).toEqual([
      { refcount: 1, delete_after: null },
    ]);
    expect(master(r)).not.toBeNull();
    expect(Object.values(variantBytes(r)).every((b) => b !== null)).toBe(true);
    expect(await objectRow(n)).not.toBeNull();
    expect(master(n)).not.toBeNull();
  });

  it('[S3-04] the sweep deletes day-old originals no record needs; it keeps those waiting to be processed or in use', async () => {
    const unregistered = await stored(await photo('unregistered').jpeg().toBuffer(), 'image/jpeg');
    const waiting = await stored(await photo('waiting').jpeg().toBuffer(), 'image/jpeg');
    const inUse = await stored(await photo('in-use').jpeg().toBuffer(), 'image/jpeg');
    const fresh = await stored(await photo('fresh').jpeg().toBuffer(), 'image/jpeg');
    await system((tx) =>
      tx.execute(sql`insert into media_objects (sha256, size_bytes, content_type)
                     values (${waiting.sha256}, ${waiting.upload.sizeBytes}, 'image/jpeg')`),
    );
    // Attached by a listing, its sync not processed yet: no record, but the original is needed.
    await attach(inUse.sha256);
    for (const x of [unregistered, waiting, inUse]) {
      const entry = store.objects.get(`private/${media.originalKey(x.sha256)}`);
      if (entry) entry.lastModified = new Date(Date.now() - DAY - 60_000);
    }

    await prune();
    expect(original(unregistered.sha256)).toBeNull();
    expect(original(waiting.sha256)).not.toBeNull();
    expect(original(inUse.sha256)).not.toBeNull();
    expect(original(fresh.sha256)).not.toBeNull();
  });

  it('[S3-04] each verified upload is queued for processing; stuck objects are queued again', async () => {
    media.registerMediaSubscriptions();
    try {
      const upload = await stored(await photo('queued').jpeg().toBuffer(), 'image/jpeg');
      const known = sha(new TextEncoder().encode(`${RUN}:known`));
      const meta = {
        eventId: newId(),
        agencyId: founder.agencyId,
        type: 'media.object.referencesChanged',
        version: 1,
        createdAt: new Date(),
        attempt: 1,
      };
      const payload = {
        listingId,
        objects: [
          { sha256: upload.sha256, upload: upload.upload },
          { sha256: known, upload: null },
        ],
      };
      for (const s of defaultSubscribers.get('media.object.referencesChanged', 1)) await s.handler(payload, meta);
      expect(await queuedFor(upload.sha256)).toHaveLength(1);
      expect(await queuedFor(known)).toHaveLength(0);

      // Recorded long ago and never processed: the reconciler queues it again. The shared test database keeps
      // earlier runs' unprocessed objects and the reconciler takes the oldest 500 first, so this run's object is
      // dated before every earlier run's (the later the run, the older the date).
      await system((tx) =>
        tx.execute(sql`insert into media_objects (sha256, size_bytes, content_type, created_at)
                       values (${known}, 1, 'image/jpeg', timestamptz '2000-01-01' - (now() - timestamptz '2000-01-01'))`),
      );
      await media.mediaJobs.reprocessStale.spec.run({}, jobCtx());
      expect(await queuedFor(known)).toHaveLength(1);
    } finally {
      media.unregisterMediaSubscriptions();
    }
  });
});
