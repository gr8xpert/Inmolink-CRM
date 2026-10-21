import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { CreateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem, withTenant } from '@inmolink/db';
import { loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';
import { configureStorage, createS3Store, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import { overdueFeedImageAgencies } from '../feed-images';
import * as media from '../index';

/** Feed images (S6-02): queued by the import, fetched later by the worker — hash-first, in feed order. */

const RUN = newId().slice(-8);
const log = createLogger({ service: 'test', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('media.feedImages.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let a: Founder;
let server: Server;
let origin: string;
let undoLoopback: () => void;
let ids: { location: string; type: string };
const hits = new Map<string, number>();

/** A JPEG-looking file unique to this run (magic bytes, then filler). */
function jpeg(label: string): Buffer {
  const bytes = Buffer.alloc(4_096);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.write(`${RUN}:${label}`, 8);
  return bytes;
}
const files: Record<string, Buffer> = { a: jpeg('a'), b: jpeg('b'), c: jpeg('c'), same: jpeg('a') };
/** S7-F3: past one upload part (5 MiB), served without a length in 64 KiB pieces; `big2` is the same bytes. */
const big = Buffer.alloc(9 * 1024 * 1024 + 321, 7);
big.set([0xff, 0xd8, 0xff, 0xe0]);
big.write(`${RUN}:big`, 8);
/** S7-F3 review: gzip-encoded, so its `content-length` (the compressed size, ~10 KB) understates the 9 MiB it decodes to. */
const lying = Buffer.from(big);
lying.write(`${RUN}:lie`, 8);
const lyingGz = gzipSync(lying);
const url = (path: string) => `${origin}/${RUN}/${path}`;

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
const newListing = async () =>
  (
    await as((ctx) =>
      properties.createListing(ctx, CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location })),
    )
  ).id;
const queue = (rowsToQueue: { listingId: string; urls: string[] }[]) =>
  withTenant({ agencyId: a.agencyId }, (tx) => media.queueFeedImages(tx, a.agencyId, rowsToQueue));
const run = () => media.importFeedImages(a.agencyId, { signal: new AbortController().signal, log });
const mediaOf = (listingId: string) =>
  rows<{ sha256: string; position: number; is_cover: boolean }>(
    sql`select sha256, position, is_cover from property_media where property_id = ${listingId} order by position`,
  );

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  a = await createFounder();
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `fi-${RUN}`,
      translations: [{ locale: 'en', name: `Feedimagia ${RUN}`, slug: `feedimagia-${RUN}` }],
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `fi-g-${RUN}`,
      sort: 0,
      translations: [{ locale: 'en', name: `Feed Image Houses ${RUN}`, slug: `fi-houses-${RUN}` }],
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `fi-t-${RUN}`,
      sort: 0,
      translations: [{ locale: 'en', name: `Feed Image Villa ${RUN}`, slug: `fi-villa-${RUN}` }],
    });
    return { location, type };
  });
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('/').at(-1) ?? '';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const name = path.replace(/\.jpg$/, '');
    const body = files[name];
    if (name === 'html') res.writeHead(200, { 'content-type': 'image/jpeg' }).end('<html>not an image</html>');
    else if (name === 'lying')
      res
        .writeHead(200, { 'content-type': 'image/jpeg', 'content-encoding': 'gzip', 'content-length': lyingGz.length })
        .end(lyingGz);
    else if (name === 'big' || name === 'big2') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      for (let at = 0; at < big.length; at += 65_536) res.write(big.subarray(at, at + 65_536));
      res.end();
    } else if (!body) res.writeHead(404).end();
    else res.writeHead(200, { 'content-type': 'image/jpeg' }).end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  undoLoopback = allowLoopbackOriginsForTests([origin]);
}, 120_000);

afterAll(async () => {
  // the object this file recorded by hand (never processed): other suites' reconciler counts must not see it
  await system((tx) => tx.execute(sql`delete from media_objects where sha256 = ${sha(files.a as Buffer)}`));
  undoLoopback();
  server.close();
  await closeDb();
});

describe('feed images', () => {
  it('[S6-02] queued images are fetched by the worker, hashed first, stored once and attached in feed order', async () => {
    const one = await newListing();
    const two = await newListing();
    await queue([
      { listingId: one, urls: [url('a.jpg'), url('missing.jpg'), url('b.jpg'), url('html.jpg')] },
      // a shared photo, and the same bytes under another URL
      { listingId: two, urls: [url('b.jpg'), url('same.jpg')] },
    ]);
    const [event] = await rows<{ n: string }>(sql`
      select count(*)::text as n from outbox_events
       where agency_id = ${a.agencyId} and type = 'media.feedImages.queued' and payload ->> 'listings' = '2'`);
    expect(event?.n).toBe('1');

    const result = await run();
    expect(result).toMatchObject({ listings: 2, downloaded: 3, failed: 2, attached: 4, more: false });
    // one download per distinct URL, failures skipped
    expect([hits.get('a.jpg'), hits.get('b.jpg'), hits.get('same.jpg'), hits.get('missing.jpg')]).toEqual([1, 1, 1, 1]);
    expect(await mediaOf(one)).toEqual([
      { sha256: sha(files.a as Buffer), position: 0, is_cover: true },
      { sha256: sha(files.b as Buffer), position: 1, is_cover: false },
    ]);
    // `same.jpg` has `a.jpg`'s bytes: one object, attached to the second listing too
    expect((await mediaOf(two)).map((m) => m.sha256)).toEqual([sha(files.b as Buffer), sha(files.a as Buffer)]);
    expect(await storage().head('work', media.originalKey(sha(files.a as Buffer)))).not.toBeNull();
    // the media worker records the new objects (upload info only on events of files this run stored)
    const changes = await rows<{ objects: { sha256: string; upload: unknown }[] }>(sql`
      select payload -> 'objects' as objects from outbox_events
       where agency_id = ${a.agencyId} and type = 'media.object.referencesChanged'
         and payload ->> 'listingId' in (${one}, ${two})`);
    expect(changes.flatMap((c) => c.objects).every((o) => o.upload !== null)).toBe(true);
    expect(await rows(sql`select 1 from feed_image_queue where property_id in (${one}, ${two})`)).toEqual([]);
  });

  it('[S6-02] a URL fetched before is not downloaded again; a new list appends only its new files', async () => {
    const listing = await newListing();
    await queue([{ listingId: listing, urls: [url('a.jpg')] }]);
    await run();
    // the media worker records the stored object (`media.syncObjects`, from the referencesChanged event)
    await system((tx) =>
      tx.execute(sql`insert into media_objects (sha256, size_bytes, content_type)
                     values (${sha(files.a as Buffer)}, 4096, 'image/jpeg') on conflict do nothing`),
    );
    const before = hits.get('a.jpg') ?? 0;
    await queue([{ listingId: listing, urls: [url('c.jpg'), url('a.jpg')] }]);
    const result = await run();
    expect(result).toMatchObject({ reused: 1, downloaded: 1, attached: 1 });
    expect(hits.get('a.jpg')).toBe(before);
    expect((await mediaOf(listing)).map((m) => m.sha256)).toEqual([sha(files.a as Buffer), sha(files.c as Buffer)]);
  });

  it('[S7-F3] an image past one upload part streams through a staging key to its content-addressed key', async () => {
    const listing = await newListing();
    await queue([{ listingId: listing, urls: [url('big.jpg'), url('big2.jpg')] }]);
    const result = await run();
    expect(result).toMatchObject({ downloaded: 2, failed: 0, attached: 1 });
    expect((await mediaOf(listing)).map((m) => m.sha256)).toEqual([sha(big)]);
    const stored = await storage().get('work', media.originalKey(sha(big)), { maxBytes: big.length });
    expect(stored && sha(stored)).toBe(sha(big));
    // both staging objects (the stored one moved, the duplicate dropped) are gone
    expect((await storage().list('work', media.FEED_STAGING_PREFIX, { limit: 10 })).objects).toEqual([]);
    const [change] = await rows<{ objects: { sha256: string; upload: unknown }[] }>(sql`
      select payload -> 'objects' as objects from outbox_events
       where agency_id = ${a.agencyId} and type = 'media.object.referencesChanged' and payload ->> 'listingId' = ${listing}`);
    expect(change?.objects).toEqual([
      { sha256: sha(big), upload: { sizeBytes: big.length, contentType: 'image/jpeg' } },
    ]);
    await storage().delete('work', media.originalKey(sha(big)));
  });

  it('[S7-F3] an image whose content-length understates it still streams with its real content type', async () => {
    const listing = await newListing();
    await queue([{ listingId: listing, urls: [url('lying.jpg')] }]);
    expect(await run()).toMatchObject({ downloaded: 1, failed: 0, attached: 1 });
    const key = media.originalKey(sha(lying));
    const stored = await storage().get('work', key, { maxBytes: lying.length });
    expect(stored && sha(stored)).toBe(sha(lying));
    // the copy keeps the staged object's type: the upload started only once the magic bytes were known
    const signed = await storage().signedGetUrl('work', key, { expiresInSeconds: 60 });
    expect((await fetch(signed)).headers.get('content-type')).toBe('image/jpeg');
    expect((await storage().list('work', media.FEED_STAGING_PREFIX, { limit: 10 })).objects).toEqual([]);
    await storage().delete('work', key);
  });

  it('[S7-F3] the overdue sweep finds agencies whose next row to claim is old (skip scan per agency)', async () => {
    const older = await newListing();
    const newer = await newListing();
    await queue([{ listingId: older, urls: [url('a.jpg')] }]);
    await queue([{ listingId: newer, urls: [url('b.jpg')] }]);
    const overdue = async () => (await overdueFeedImageAgencies(1_000)).includes(a.agencyId);
    const age = (listing: string, set: ReturnType<typeof sql>) =>
      system((tx) => tx.execute(sql`update feed_image_queue set ${set} where property_id = ${listing}`));
    expect(await overdue()).toBe(false);
    // both untouched for 20 minutes and unclaimed (their job was lost): overdue
    await age(older, sql`updated_at = now() - interval '20 minutes'`);
    await age(newer, sql`updated_at = now() - interval '20 minutes'`);
    expect(await overdue()).toBe(true);
    // a live job holds the oldest and the next one was just queued again: not overdue
    await age(older, sql`claimed_until = now() + interval '5 minutes'`);
    await age(newer, sql`updated_at = now()`);
    expect(await overdue()).toBe(false);
    // the job died: its lease lapsed, the row it held is old again
    await age(older, sql`claimed_until = now() - interval '1 minute'`);
    expect(await overdue()).toBe(true);
    await system((tx) => tx.execute(sql`delete from feed_image_queue where property_id in (${older}, ${newer})`));
  });

  it('[S7-F3] feed-image jobs are capped per process and across the pool from config', () => {
    const spec = media.mediaJobs.importFeedImages.spec;
    const cap = (c: typeof spec.perProcessConcurrency) => (typeof c === 'function' ? c() : c);
    expect([cap(spec.perProcessConcurrency), cap(spec.globalConcurrency)]).toEqual([4, 32]);
    media.configureFeedImages({ jobsPerProcess: 2, maxConcurrentJobs: 8 });
    expect([cap(spec.perProcessConcurrency), cap(spec.globalConcurrency)]).toEqual([2, 8]);
    media.configureFeedImages({});
  });

  it('[S6-02] a deleted listing gets nothing and its queue row goes', async () => {
    const listing = await newListing();
    await queue([{ listingId: listing, urls: [url('b.jpg')] }]);
    await as((ctx) => properties.deleteListing(ctx, listing));
    await run();
    expect(await mediaOf(listing)).toEqual([]);
    expect(await rows(sql`select 1 from feed_image_queue where property_id = ${listing}`)).toEqual([]);
  });
});
