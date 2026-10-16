import { CreateListingBody, parseVideoUrl } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { configureStorage, createS3Store, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as media from '../index';

/** Listing videos (links) and documents (private PDFs) — S3-F5. */

// Names, slugs and keys carry the run id (listings reference them, so earlier runs' rows stay; S3-F3 decision 1).
const PREFIX = 'mvd-';
const RUN = newId().slice(-8).toLowerCase();
const key = (s: string) => `${PREFIX}${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: key(slug) }];

let a: Founder;
let b: Founder;
let ids: { location: string; type: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>, clientMode = false) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, (ctx) =>
    fn(clientMode ? { ...ctx, clientMode: true } : ctx),
  );
const runner =
  (m: Founder) =>
  <T>(fn: (ctx: Ctx) => Promise<T>) =>
    as(m, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );

/** A PDF-looking file unique to this run (magic bytes, then filler). */
const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.7\n% ${RUN} ${label}\n%%EOF\n`);
const jpegBytes = (label: string) => {
  const bytes = new Uint8Array(512);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.set(new TextEncoder().encode(label), 8);
  return bytes;
};

async function listing(m: Founder): Promise<string> {
  return (
    await as(m, (ctx) =>
      properties.createListing(ctx, CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location })),
    )
  ).id;
}

const keys: string[] = [];

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  media.configureMedia({ urlKey: `media-vd-key-${RUN}-0123456789abcdef` });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const f of [a, b]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await withSystem('media.videos.test', async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      translations: tr(`Videoland ${RUN}`, 'videoland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: key('houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: key('villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'villa'),
    });
    return { location, type };
  });
}, 120_000);

afterAll(async () => {
  for (const k of keys)
    await storage()
      .delete('private', k)
      .catch(() => {});
  await closeDb();
});

describe('video links', () => {
  it('[S3-F5] a YouTube or Vimeo link is added, reordered with the photos and shown as a video; other hosts are refused', async () => {
    expect(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toEqual({
      provider: 'youtube',
      id: 'dQw4w9WgXcQ',
    });
    expect(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toEqual({ provider: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseVideoUrl('https://vimeo.com/76979871')).toEqual({ provider: 'vimeo', id: '76979871' });
    expect(parseVideoUrl('https://my.matterport.com/show/?m=SxQL3iGyoDo')).toEqual({
      provider: 'matterport',
      id: 'SxQL3iGyoDo',
    });
    for (const bad of [
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
      'https://www.youtube.com/watch?v=<script>',
      'not a url',
    ]) {
      expect(parseVideoUrl(bad), bad).toBeNull();
    }

    const id = await listing(a);
    const add = (url: string) => as(a, (ctx) => media.addListingVideo(ctx, { listingId: id, url }));
    await add('https://youtu.be/dQw4w9WgXcQ');
    const list = await add('https://vimeo.com/76979871');
    expect(list.items.map((m) => [m.kind, m.sha256, m.video?.provider])).toEqual([
      ['VIDEO', null, 'youtube'],
      ['VIDEO', null, 'vimeo'],
    ]);
    expect(list.items[0]?.video?.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(list.items.every((m) => m.thumbUrl === null && !m.isCover)).toBe(true);
    expect(await refusal(add('https://evil.example/watch?v=dQw4w9WgXcQ'))).toBe('VIDEO_URL_NOT_ALLOWED');
    expect(await refusal(add('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe('VIDEO_ALREADY_ADDED');

    // Reordered like any media; a video never becomes a photo or the cover.
    const reordered = await as(a, (ctx) =>
      media.reorderListingMedia(ctx, { listingId: id, ids: [...list.items].reverse().map((m) => m.id) }),
    );
    expect(reordered.items.map((m) => m.video?.provider)).toEqual(['vimeo', 'youtube']);
    const first = reordered.items[0]?.id as string;
    expect(
      await refusal(
        as(a, (ctx) => media.updateListingMedia(ctx, { listingId: id, mediaId: first, patch: { cover: true } })),
      ),
    ).toBe('VALIDATION_FAILED');
    // Removing a video references no stored object.
    await as(a, (ctx) => media.detachListingMedia(ctx, { listingId: id, mediaId: first }));
    const left = await as(a, (ctx) => media.listListingMedia(ctx, id));
    expect(left.items.map((m) => [m.video?.provider, m.position])).toEqual([['youtube', 0]]);
    // Another agency cannot add one to it.
    expect(
      await refusal(as(b, (ctx) => media.addListingVideo(ctx, { listingId: id, url: 'https://vimeo.com/1' }))),
    ).toBe('LISTING_NOT_FOUND');
  });
});

describe('listing documents', () => {
  it('[S3-F5] a PDF uploads and only the owner agency can open it; a non-PDF with a .pdf name is refused', async () => {
    const id = await listing(a);
    const doc = await media.uploadListingDocument(runner(a), {
      listingId: id,
      fileName: 'Nota simple../../x.pdf',
      body: pdf('nota'),
    });
    expect(doc).toMatchObject({ fileName: 'Nota simple....x.pdf', sizeBytes: pdf('nota').byteLength });
    // A retried upload of the same file answers with the same document.
    expect(
      (await media.uploadListingDocument(runner(a), { listingId: id, fileName: 'again', body: pdf('nota') })).id,
    ).toBe(doc.id);

    const list = await as(a, (ctx) => media.listListingDocuments(ctx, id));
    expect(list.items.map((d) => d.id)).toEqual([doc.id]);
    const opened = await as(a, (ctx) => media.openListingDocument(ctx, { listingId: id, documentId: doc.id }));
    const res = await fetch(opened.url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf('nota'));
    keys.push(new URL(opened.url).pathname.split('/').slice(2).join('/'));

    // Another agency: its listing is not readable, and the row is not there either (STRICT); Client Mode: never.
    expect(await refusal(as(b, (ctx) => media.openListingDocument(ctx, { listingId: id, documentId: doc.id })))).toBe(
      'LISTING_NOT_FOUND',
    );
    expect(await refusal(as(a, (ctx) => media.listListingDocuments(ctx, id), true))).toBe('FORBIDDEN');
    expect(
      await refusal(media.uploadListingDocument(runner(b), { listingId: id, fileName: 'x.pdf', body: pdf('b') })),
    ).toBe('LISTING_NOT_FOUND');

    // The real type decides: an image renamed to .pdf is refused, and nothing is stored.
    expect(
      await refusal(
        media.uploadListingDocument(runner(a), { listingId: id, fileName: 'fake.pdf', body: jpegBytes('x') }),
      ),
    ).toBe('DOCUMENT_TYPE_NOT_ALLOWED');
    // A configured scanner can refuse a file.
    media.configureDocumentScanner(async () => 'infected');
    try {
      expect(
        await refusal(media.uploadListingDocument(runner(a), { listingId: id, fileName: 'v.pdf', body: pdf('virus') })),
      ).toBe('DOCUMENT_TYPE_NOT_ALLOWED');
    } finally {
      media.configureDocumentScanner(async () => 'clean');
    }

    await media.deleteListingDocument(runner(a), { listingId: id, documentId: doc.id });
    expect((await as(a, (ctx) => media.listListingDocuments(ctx, id))).items).toEqual([]);
    expect((await fetch(opened.url)).status).toBe(404);
  });
});
