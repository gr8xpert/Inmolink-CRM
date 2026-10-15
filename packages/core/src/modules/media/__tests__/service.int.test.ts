import { createHash } from 'node:crypto';
import {
  CreateListingBody,
  MediaCheckBody,
  type MediaCheckResult,
  RegisterMediaBody,
  UpdateListingMediaBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureStorage, createS3Store, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as media from '../index';

/** Listing media upload pipeline on the real database and MinIO (S3-03). */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const log = createLogger({ service: 'test', level: 'silent' });

let a: Founder;
let b: Founder;
let ids: { location: string; type: string };
const agencies = () => [a.agencyId, b.agencyId];

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const runner =
  (m: Founder) =>
  <T>(fn: (ctx: Ctx) => Promise<T>) =>
    as(m, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('media.service.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** A JPEG-looking file unique to this run (magic bytes, then filler). */
function jpeg(label: string, size = 2_048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.set(new TextEncoder().encode(`${RUN}:${label}`), 8);
  return bytes;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fileOf = (bytes: Uint8Array, contentType: 'image/jpeg' | 'image/png' = 'image/jpeg') => ({
  sha256: sha(bytes),
  sizeBytes: bytes.byteLength,
  contentType,
});

async function listing(m: Founder): Promise<string> {
  const dto = await as(m, (ctx) =>
    properties.createListing(ctx, CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location })),
  );
  return dto.id;
}

const check = (m: Founder, files: Uint8Array[]) =>
  as(m, (ctx) => media.checkUploads(ctx, MediaCheckBody.parse({ files: files.map((f) => fileOf(f)) })));
const register = (m: Founder, listingId: string, files: Uint8Array[], extra: Partial<RegisterMediaBody> = {}) =>
  media.registerUploads(
    runner(m),
    RegisterMediaBody.parse({ listingId, files: files.map((f) => ({ sha256: sha(f) })), ...extra }),
  );

/** Browsers set `content-length` themselves (a forbidden header); fetch in Node must not be given a wrong one. */
const browserHeaders = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-length'));

/** What a browser does with an UPLOAD answer: PUT the bytes with the signed headers. */
let bytesSent = 0;
async function upload(result: MediaCheckResult, files: Uint8Array[]): Promise<number[]> {
  const statuses: number[] = [];
  for (const entry of result.files) {
    if (!entry.upload) continue;
    const body = files.find((f) => sha(f) === entry.sha256);
    if (!body) throw new Error('upload: unknown file');
    const res = await fetch(entry.upload.url, { method: 'PUT', body, headers: browserHeaders(entry.upload.headers) });
    await res.body?.cancel();
    bytesSent += body.byteLength;
    statuses.push(res.status);
  }
  return statuses;
}

/** The dispatcher's part: runs `media.syncObjects` for this file's pending events, in order. */
async function sync(): Promise<void> {
  const events = await rows<{ id: string; agency_id: string; payload: { objects: [] } }>(
    sql`select id, agency_id, payload from outbox_events
         where type = 'media.object.referencesChanged' and processed_at is null
           and agency_id in (${sql.join(
             agencies().map((x) => sql`${x}`),
             sql`, `,
           )}) order by id`,
  );
  for (const e of events) {
    await media.mediaJobs.syncObjects.spec.run(
      { eventId: e.id, agencyId: e.agency_id, objects: e.payload.objects },
      { log, jobId: e.id, attempt: 1, progress: async () => {}, signal: new AbortController().signal },
    );
    await system((tx) => tx.execute(sql`update outbox_events set processed_at = now() where id = ${e.id}`));
  }
}

const objectOf = async (bytes: Uint8Array) =>
  (
    await rows<{ refcount: number; delete_after: string | null; content_type: string; size_bytes: string }>(
      sql`select refcount, to_char(delete_after at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as delete_after,
                 content_type, size_bytes
            from media_objects where sha256 = ${sha(bytes)}`,
    )
  )[0] ?? null;

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  media.configureMedia({ urlKey: `media-test-key-${RUN}-0123456789abcdef` });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const f of [a, b]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('mc'),
      translations: tr(`Medialand ${RUN}`, 'medialand'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('m-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'm-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('m-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'm-villa'),
    });
    return { location, type };
  });
}, 120_000);

afterEach(restoreClock);
afterAll(closeDb);

describe('media upload pipeline', () => {
  it('[S3-03] uploading a file that already exists anywhere in the system transfers zero bytes and increments refcount', async () => {
    const photo = jpeg('shared');
    // Agency A uploads it first: one signed PUT, then register.
    const first = await check(a, [photo]);
    expect(first.files).toEqual([expect.objectContaining({ sha256: sha(photo), status: 'UPLOAD' })]);
    expect(await upload(first, [photo])).toEqual([200]);
    const listingA = await listing(a);
    await register(a, listingA, [photo]);
    await sync();
    expect(await objectOf(photo)).toMatchObject({ refcount: 1, delete_after: null, content_type: 'image/jpeg' });

    // Agency B has the same file: nothing to upload, and its listing uses the stored object.
    bytesSent = 0;
    const second = await check(b, [photo]);
    expect(second.files).toEqual([{ sha256: sha(photo), status: 'STORED', upload: null }]);
    await upload(second, [photo]);
    expect(bytesSent).toBe(0);
    const listingB = await listing(b);
    const attached = await register(b, listingB, [photo]);
    expect(attached.items).toEqual([expect.objectContaining({ sha256: sha(photo), position: 0, isCover: true })]);
    await sync();
    expect((await objectOf(photo))?.refcount).toBe(2);
  });

  it('[S3-03] non-image bytes with an image extension are rejected', async () => {
    // "holiday.jpg": an HTML page, declared as a JPEG by the browser.
    const fake = new TextEncoder().encode(`<html><script>alert(1)</script>${RUN}</html>`);
    const result = await check(a, [fake]);
    expect(await upload(result, [fake])).toEqual([200]);
    const id = await listing(a);
    expect(await refusal(register(a, id, [fake]))).toBe('MEDIA_TYPE_NOT_ALLOWED');
    // The object is gone, nothing was attached or recorded.
    expect(await storage().head('private', media.originalKey(sha(fake)))).toBeNull();
    expect((await as(a, (ctx) => media.listListingMedia(ctx, id))).items).toEqual([]);
    await sync();
    expect(await objectOf(fake)).toBeNull();
  });

  it('[S3-03] detaching the last reference schedules deletion after 7 days', async () => {
    const photo = jpeg('detach');
    await upload(await check(a, [photo]), [photo]);
    const [one, two] = [await listing(a), await listing(a)];
    const m1 = (await register(a, one, [photo])).items[0];
    const m2 = (await register(a, two, [photo])).items[0];
    await sync();
    expect((await objectOf(photo))?.refcount).toBe(2);

    const clock = useFakeClock('2026-11-02T10:00:00Z');
    await as(a, (ctx) => media.detachListingMedia(ctx, { listingId: one, mediaId: m1?.id ?? '' }));
    await sync();
    expect(await objectOf(photo)).toMatchObject({ refcount: 1, delete_after: null });

    await as(a, (ctx) => media.detachListingMedia(ctx, { listingId: two, mediaId: m2?.id ?? '' }));
    await sync();
    const orphan = await objectOf(photo);
    expect(orphan?.refcount).toBe(0);
    expect(orphan?.delete_after).toBe('2026-11-09T10:00:00Z');

    // A repeated delivery a day later keeps the first schedule; using the file again cancels it.
    clock.advance(86_400_000);
    await system((tx) =>
      tx.execute(
        sql`update outbox_events set processed_at = null where id = (select id from outbox_events
             where type = 'media.object.referencesChanged' and agency_id = ${a.agencyId} order by id desc limit 1)`,
      ),
    );
    await sync();
    expect((await objectOf(photo))?.delete_after).toBe('2026-11-09T10:00:00Z');
    // A pending deletion is not trusted: the next check asks for the upload again, and register re-verifies.
    expect((await check(a, [photo])).files[0]?.status).toBe('UPLOAD');
    await register(a, one, [photo]);
    await sync();
    expect(await objectOf(photo)).toMatchObject({ refcount: 1, delete_after: null });
  });

  it('[S3-03] a signed upload accepts only the declared file: other bytes or another length are refused', async () => {
    const photo = jpeg('signed');
    const [entry] = (await check(a, [photo])).files;
    const put = (body: Uint8Array, headers = entry?.upload?.headers ?? {}) =>
      fetch(entry?.upload?.url ?? '', { method: 'PUT', body, headers: browserHeaders(headers) }).then(async (r) => {
        await r.body?.cancel();
        return r.status;
      });
    const tampered = photo.slice();
    tampered[100] = 1;
    expect(await put(tampered)).toBeGreaterThanOrEqual(400);
    expect(await put(jpeg('signed', 4_096))).toBeGreaterThanOrEqual(400);
    const { 'x-amz-checksum-sha256': _, ...unsigned } = entry?.upload?.headers ?? {};
    expect(await put(photo, unsigned)).toBeGreaterThanOrEqual(400);
    expect(await storage().head('private', media.originalKey(sha(photo)))).toBeNull();
    expect(await put(photo)).toBe(200);
    // Create-only: a stored original is never overwritten through a signed URL.
    expect(await put(photo)).toBe(412);
  });

  it('[S3-03] registering before the upload finished is refused, and needs no lock on a foreign listing', async () => {
    const photo = jpeg('missing');
    const id = await listing(a);
    expect(await refusal(register(a, id, [photo]))).toBe('MEDIA_NOT_UPLOADED');
    // Another agency's listing is refused before any storage I/O.
    expect(await refusal(register(b, id, [photo]))).toBe('LISTING_NOT_FOUND');
  });

  it('[S3-03] files keep their order, insert at a position, keep one cover, and a retried register is a no-op', async () => {
    const [p1, p2, p3, p4] = ['o1', 'o2', 'o3', 'o4'].map((l) => jpeg(l));
    const all = [p1, p2, p3, p4] as Uint8Array[];
    await upload(await check(a, all), all);
    const id = await listing(a);
    const first = await register(a, id, [p1, p2] as Uint8Array[]);
    expect(first.items.map((m) => [m.sha256, m.position, m.isCover])).toEqual([
      [sha(p1 as Uint8Array), 0, true],
      [sha(p2 as Uint8Array), 1, false],
    ]);
    const again = await register(a, id, [p1, p2] as Uint8Array[]);
    expect(again.items.map((m) => m.id)).toEqual(first.items.map((m) => m.id));

    const inserted = await media.registerUploads(
      runner(a),
      RegisterMediaBody.parse({
        listingId: id,
        position: 1,
        files: [
          { sha256: sha(p3 as Uint8Array), cover: true },
          { sha256: sha(p4 as Uint8Array), kind: 'FLOOR_PLAN' },
        ],
      }),
    );
    expect(inserted.items.map((m) => [m.sha256, m.position, m.isCover, m.kind])).toEqual([
      [sha(p1 as Uint8Array), 0, false, 'IMAGE'],
      [sha(p3 as Uint8Array), 1, true, 'IMAGE'],
      [sha(p4 as Uint8Array), 2, false, 'FLOOR_PLAN'],
      [sha(p2 as Uint8Array), 3, false, 'IMAGE'],
    ]);

    // Removing the cover closes the gap and hands the cover to the first image.
    const cover = inserted.items[1];
    await as(a, (ctx) => media.detachListingMedia(ctx, { listingId: id, mediaId: cover?.id ?? '' }));
    const left = await as(a, (ctx) => media.listListingMedia(ctx, id));
    expect(left.items.map((m) => [m.sha256, m.position, m.isCover])).toEqual([
      [sha(p1 as Uint8Array), 0, true],
      [sha(p4 as Uint8Array), 1, false],
      [sha(p2 as Uint8Array), 2, false],
    ]);
    expect(
      await refusal(as(a, (ctx) => media.detachListingMedia(ctx, { listingId: id, mediaId: cover?.id ?? '' }))),
    ).toBe('MEDIA_NOT_FOUND');
    await sync();
  });

  it('[S3-03] another agency cannot read, attach to or detach from a private listing', async () => {
    const photo = jpeg('foreign');
    await upload(await check(a, [photo]), [photo]);
    const id = await listing(a);
    const [m] = (await register(a, id, [photo])).items;
    expect(await refusal(as(b, (ctx) => media.listListingMedia(ctx, id)))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(as(b, (ctx) => media.detachListingMedia(ctx, { listingId: id, mediaId: m?.id ?? '' })))).toBe(
      'LISTING_NOT_FOUND',
    );
    expect((await as(a, (ctx) => media.listListingMedia(ctx, id))).items).toHaveLength(1);
    await sync();
  });

  it('[S3-03] an agent changes only the media of their own listings (admins any)', async () => {
    const agentId = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
        values (${agentId}, ${`agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
      await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
        values (${a.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`agent-${agentId}@example.com`})`);
    });
    const agent = { ...a, userId: agentId };
    const photo = jpeg('colleague');
    await upload(await check(agent, [photo]), [photo]);
    const adminsListing = await listing(a);
    expect(await refusal(register(agent, adminsListing, [photo]))).toBe('FORBIDDEN');
    const own = await listing(agent);
    const [m] = (await register(agent, own, [photo])).items;
    // the admin may fix the agent's listing
    await as(a, (ctx) => media.detachListingMedia(ctx, { listingId: own, mediaId: m?.id ?? '' }));
    await sync();
  });

  it('[S3-03] registering 100 new files stays within the dashboard query budget', async () => {
    const files = Array.from({ length: 100 }, (_, i) => jpeg(`budget-${i}`, 64));
    await upload(await check(a, files), files);
    const id = await listing(a);
    const n = await countQueries(() => register(a, id, files));
    expect(n).toBeLessThanOrEqual(10);
    await sync();
    expect((await as(a, (ctx) => media.listListingMedia(ctx, id))).items).toHaveLength(100);
  });

  it('[S3-03] a check of 100 files is one query and signs locally', async () => {
    const files = Array.from({ length: 100 }, (_, i) => fileOf(jpeg(`batch-${i}`)));
    const n = await countQueries(() => as(a, (ctx) => media.checkUploads(ctx, MediaCheckBody.parse({ files }))));
    // member context (membership + agency) and the one stored-hash probe
    expect(n).toBeLessThanOrEqual(4);
  });

  // --- media manager (S3-06) ---------------------------------------------------------------------------------

  const edit = (m: Founder, listingId: string, mediaId: string, patch: unknown) =>
    as(m, (ctx) => media.updateListingMedia(ctx, { listingId, mediaId, patch: UpdateListingMediaBody.parse(patch) }));
  const reorder = (m: Founder, listingId: string, ids: string[]) =>
    as(m, (ctx) => media.reorderListingMedia(ctx, { listingId, ids }));

  it('[S3-06] order persists: a reorder puts every file where it was dropped; a stale order is refused', async () => {
    const files = ['r1', 'r2', 'r3', 'r4'].map((l) => jpeg(l));
    await upload(await check(a, files), files);
    const id = await listing(a);
    const listed = (await register(a, id, files)).items;
    const [m1, m2, m3, m4] = listed.map((m) => m.id) as [string, string, string, string];

    const moved = await reorder(a, id, [m3, m1, m4, m2]);
    expect(moved.items.map((m) => [m.id, m.position])).toEqual([
      [m3, 0],
      [m1, 1],
      [m4, 2],
      [m2, 3],
    ]);
    // the cover stays with its file
    expect(moved.items.find((m) => m.isCover)?.id).toBe(m1);
    expect((await as(a, (ctx) => media.listListingMedia(ctx, id))).items.map((m) => m.id)).toEqual([m3, m1, m4, m2]);

    // missing one, or naming one the listing does not have: another tab changed the media
    expect(await refusal(reorder(a, id, [m3, m1, m4]))).toBe('MEDIA_ORDER_STALE');
    expect(await refusal(reorder(a, id, [m3, m1, m4, newId()]))).toBe('MEDIA_ORDER_STALE');
    // another agency cannot reorder or edit
    expect(await refusal(reorder(b, id, [m1, m2, m3, m4]))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(edit(b, id, m1, { altText: 'x' }))).toBe('LISTING_NOT_FOUND');
    await sync();
  });

  it('[S3-06] cover, room type, alt text and floor plans are set per file; a cover turned floor plan passes the cover on', async () => {
    const files = ['e1', 'e2', 'e3'].map((l) => jpeg(l));
    await upload(await check(a, files), files);
    const id = await listing(a);
    const [m1, m2, m3] = (await register(a, id, files)).items.map((m) => m.id) as [string, string, string];

    const described = await edit(a, id, m2, { altText: ' Sea view from the terrace ', roomType: 'TERRACE' });
    expect(described.items[1]).toMatchObject({ altText: 'Sea view from the terrace', roomType: 'TERRACE' });
    const cleared = await edit(a, id, m2, { altText: null, roomType: null });
    expect(cleared.items[1]).toMatchObject({ altText: null, roomType: null });

    const covered = await edit(a, id, m3, { cover: true });
    expect(covered.items.map((m) => m.isCover)).toEqual([false, false, true]);

    // the cover becomes a floor plan: the first image takes the cover
    const plan = await edit(a, id, m3, { kind: 'FLOOR_PLAN' });
    expect(plan.items.map((m) => [m.id, m.kind, m.isCover])).toEqual([
      [m1, 'IMAGE', true],
      [m2, 'IMAGE', false],
      [m3, 'FLOOR_PLAN', false],
    ]);
    // a floor plan cannot be the cover; an unknown file is not found
    expect(await refusal(edit(a, id, m3, { cover: true }))).toBe('VALIDATION_FAILED');
    expect(await refusal(edit(a, id, newId(), { altText: 'x' }))).toBe('MEDIA_NOT_FOUND');
    await sync();
  });

  it('[S3-06] a processed file lists a signed 320 px preview; an unprocessed one none', async () => {
    const [done, pending] = ['t1', 't2'].map((l) => jpeg(l)) as [Uint8Array, Uint8Array];
    await upload(await check(a, [done, pending]), [done, pending]);
    const id = await listing(a);
    await register(a, id, [done, pending]);
    await sync();
    await system((tx) =>
      tx.execute(sql`update media_objects set pipeline = 1, variants_ready = 31, width = 800, height = 600
                      where sha256 = ${sha(done)}`),
    );
    const [first, second] = (await as(a, (ctx) => media.listListingMedia(ctx, id))).items;
    expect(first?.thumbUrl).toMatch(/\/v1\/[0-9a-f]{32}\/thumb\.webp\?/);
    expect(first?.thumbUrl).not.toContain(sha(done));
    expect(second?.thumbUrl).toBeNull();
  });

  it('[S3-06] reordering and editing 100 files stay within the dashboard query budget', async () => {
    const files = Array.from({ length: 100 }, (_, i) => jpeg(`order-${i}`, 64));
    await upload(await check(a, files), files);
    const id = await listing(a);
    const ids = (await register(a, id, files)).items.map((m) => m.id);
    expect(await countQueries(() => reorder(a, id, [...ids].reverse()))).toBeLessThanOrEqual(10);
    expect(await countQueries(() => edit(a, id, ids[5] ?? '', { cover: true, roomType: 'POOL' }))).toBeLessThanOrEqual(
      10,
    );
    await sync();
  });
});
