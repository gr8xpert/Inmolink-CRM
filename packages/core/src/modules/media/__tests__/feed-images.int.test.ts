import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
    else if (!body) res.writeHead(404).end();
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

  it('[S6-02] a deleted listing gets nothing and its queue row goes', async () => {
    const listing = await newListing();
    await queue([{ listingId: listing, urls: [url('b.jpg')] }]);
    await as((ctx) => properties.deleteListing(ctx, listing));
    await run();
    expect(await mediaOf(listing)).toEqual([]);
    expect(await rows(sql`select 1 from feed_image_queue where property_id = ${listing}`)).toEqual([]);
  });
});
