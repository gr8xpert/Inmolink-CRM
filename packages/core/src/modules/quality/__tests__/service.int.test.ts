import { createHash } from 'node:crypto';
import {
  CreateListingBody,
  ListListingsQuery,
  MediaCheckBody,
  RegisterMediaBody,
  StartListingBulkBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem, withTenant } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureStorage, createS3Store, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as media from '../../media';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as quality from '../index';

/** Listing quality score and freshness on the real database and MinIO (S3-08). */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const log = createLogger({ service: 'quality.test', level: 'silent' });
const jobCtx = () => ({
  log,
  jobId: newId(),
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

let a: Founder;
let b: Founder;
let ids: { location: string; type: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>, clientMode = false) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, (ctx) =>
    fn({ ...ctx, clientMode }),
  );
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('quality.service.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

async function createListing(m: Founder): Promise<string> {
  const dto = await as(m, (ctx) =>
    properties.createListing(ctx, CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location })),
  );
  return dto.id;
}

/** A JPEG-looking file unique to this run (magic bytes, then filler): stored and registered, never processable. */
function jpeg(label: string): Uint8Array {
  const bytes = new Uint8Array(2_048);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.set(new TextEncoder().encode(`${RUN}:${label}`), 8);
  return bytes;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** What the media manager does: check, PUT the new files to their signed URLs, register them on the listing. */
async function addPhotos(m: Founder, listingId: string, files: Uint8Array[]): Promise<void> {
  const files_ = files.map((f) => ({ sha256: sha(f), sizeBytes: f.byteLength, contentType: 'image/jpeg' as const }));
  const checked = await media.checkUploads((fn) => as(m, fn), MediaCheckBody.parse({ listingId, files: files_ }));
  for (const entry of checked.files) {
    if (!entry.upload) continue;
    const body = files.find((f) => sha(f) === entry.sha256);
    const headers = Object.fromEntries(Object.entries(entry.upload.headers).filter(([k]) => k !== 'content-length'));
    const res = await fetch(entry.upload.url, { method: 'PUT', body, headers });
    await res.body?.cancel();
    expect(res.status).toBe(200);
  }
  await media.registerUploads(
    (fn) => as(m, fn),
    RegisterMediaBody.parse({ listingId, files: files.map((f) => ({ sha256: sha(f) })) }),
  );
}

type Enqueued = Parameters<typeof quality.qualityJobs.recomputeListing.enqueue>;

/**
 * The worker's part, in order: delivers the agency's pending events to the quality subscriptions (the queue
 * captured), then runs every recompute they queued. Answers what was queued.
 */
async function deliver(m: Founder): Promise<Enqueued[]> {
  const queued: Enqueued[] = [];
  const enqueue = vi.spyOn(quality.qualityJobs.recomputeListing, 'enqueue').mockImplementation(async (...args) => {
    queued.push(args);
    return { id: 'test' };
  });
  quality.registerQualitySubscriptions();
  try {
    const events = await rows<{ id: string; agency_id: string; type: string; version: number; payload: unknown }>(
      sql`select id, agency_id, type, version, payload from outbox_events
           where agency_id = ${m.agencyId} and processed_at is null order by id`,
    );
    for (const e of events) {
      const meta = {
        eventId: e.id,
        agencyId: e.agency_id,
        type: e.type,
        version: e.version,
        createdAt: new Date(),
        attempt: 1,
      };
      for (const s of defaultSubscribers.get(e.type, e.version)) {
        if (s.name.startsWith('quality.')) await s.handler(e.payload as never, meta);
      }
    }
    // One statement for the batch (a bulk action leaves a thousand events).
    if (events.length > 0) {
      await system((tx) =>
        tx.execute(
          sql`update outbox_events set processed_at = now() where id in (${sql.join(
            events.map((e) => sql`${e.id}`),
            sql`, `,
          )})`,
        ),
      );
    }
    // The jobs the events queued (a recheck they queue in turn is only recorded).
    for (const [payload] of [...queued]) {
      await quality.qualityJobs.recomputeListing.spec.run(
        quality.qualityJobs.recomputeListing.spec.payload.parse(payload),
        jobCtx(),
      );
    }
  } finally {
    quality.unregisterQualitySubscriptions();
    enqueue.mockRestore();
  }
  return queued;
}

const storedScore = async (m: Founder, id: string) =>
  (await as(m, (ctx) => properties.getListing(ctx, id))).qualityScore;

/** What another agency's network view returns: the listing, or why not. */
const networkView = (m: Founder, id: string) =>
  refusal(as(m, (ctx) => properties.getListing(ctx, id))).then((r) => (r === 'resolved' ? 'visible' : r));

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  media.configureMedia({ urlKey: `quality-test-key-${RUN}-0123456789abcdef` });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const f of [a, b]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('qc'),
      translations: tr(`Qualityland ${RUN}`, 'qualityland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('q-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'q-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('q-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'q-villa'),
    });
    return { location, type };
  });
}, 120_000);

afterAll(async () => {
  await system((tx) => tx.execute(sql`delete from properties where agency_id in (${a.agencyId}, ${b.agencyId})`));
  await closeRateLimit();
  await closeDb();
});

describe('listing quality score', () => {
  it('[S3-08] score changes after adding photos without a manual refresh', async () => {
    const id = await createListing(a);
    // Created: the subscription queues a recompute; the worker stores the score.
    expect(await deliver(a)).toEqual([
      [
        { listingId: id, agencyId: a.agencyId, recheck: 0 },
        { debounceMs: 2_000, debounceKey: id },
      ],
    ]);
    const before = await storedScore(a, id);
    expect(before).toBe((await as(a, (ctx) => quality.getListingQuality(ctx, id))).score);
    expect(before).not.toBeNull();

    // Photos added: the media event alone moves the stored score — nobody asks for it.
    await addPhotos(a, id, [jpeg('one'), jpeg('two'), jpeg('three')]);
    const queued = await deliver(a);
    const after = await storedScore(a, id);
    expect(after).toBeGreaterThan(before as number);
    // The editor's live score agrees, and says the photos are still processing…
    const live = await as(a, (ctx) => quality.getListingQuality(ctx, id));
    expect(live).toMatchObject({ listingId: id, score: after, pendingPhotos: 3 });
    expect(live.hints.find((h) => h.code === 'PHOTOS_FEW')?.params).toEqual({ count: 3, target: 15 });
    // …so the job looks again a minute later, when their size is known.
    expect(queued.at(-1)).toEqual([
      { listingId: id, agencyId: a.agencyId, recheck: 1 },
      { debounceMs: 60_000, debounceKey: `${id}.recheck` },
    ]);
    // The media worker records and processes them: 640 × 480, below the size a sharp photo needs.
    const small = ['one', 'two', 'three'].map((l) => sql`(${sha(jpeg(l))}, 2048, 'image/jpeg', 1, 640, 480)`);
    await system((tx) =>
      tx.execute(sql`insert into media_objects (sha256, size_bytes, content_type, pipeline, width, height)
                     values ${sql.join(small, sql`, `)}
                     on conflict (sha256) do update set pipeline = 1, width = 640, height = 480`),
    );
    const recheck = queued.at(-1)?.[0];
    if (!recheck) throw new Error('no recheck queued');
    await quality.qualityJobs.recomputeListing.spec.run(
      quality.qualityJobs.recomputeListing.spec.payload.parse(recheck),
      jobCtx(),
    );
    expect(await storedScore(a, id)).toBe((after as number) - 10); // three small photos: no resolution points
  });

  it('[S3-08] the live score is the owner agency’s: three reads after the member context (5 statements), never another agency’s, never in Client Mode', async () => {
    const id = await createListing(a);
    await as(a, (ctx) => properties.updateListing(ctx, id, { version: 1, status: 'ACTIVE', visibility: 'SHARED' }));
    let result: Awaited<ReturnType<typeof quality.getListingQuality>> | undefined;
    const queries = await countQueries(async () => {
      result = await as(a, (ctx) => quality.getListingQuality(ctx, id));
    });
    expect(result?.listingId).toBe(id);
    expect(queries).toBe(5); // member context (2 statements, S2-F1) + listing, translations, photos
    // B sees the shared listing on the network, but not its score (it tells freshness).
    expect(await networkView(b, id)).toBe('visible');
    expect((await as(b, (ctx) => properties.getListing(ctx, id))).qualityScore).toBeNull();
    expect(await refusal(as(b, (ctx) => quality.getListingQuality(ctx, id)))).toBe('FORBIDDEN');
    expect(await refusal(as(a, (ctx) => quality.getListingQuality(ctx, id), true))).toBe('FORBIDDEN');
    expect(await refusal(as(a, (ctx) => quality.getListingQuality(ctx, newId())))).toBe('LISTING_NOT_FOUND');
    expect((await as(a, (ctx) => properties.getListing(ctx, id), true)).qualityScore).toBeNull();
  });
});

describe('recompute triggers', () => {
  it('[S4-F2] a bulk price action on 1,000 listings enqueues no quality recompute', async () => {
    const ids_ = (
      await rows<{ id: string }>(sql`
        insert into properties (id, agency_id, owner_user_id, ref, price_cents, property_type_id, location_id)
        select gen_random_uuid(), ${a.agencyId}, ${a.userId}, ${`QB-${RUN}-`} || lpad(i::text, 5, '0'),
               10000000 + i * 100000, ${ids.type}, ${ids.location}
          from generate_series(1, 1000) as i
        returning id`)
    ).map((r) => r.id);
    const bulk = await as(a, (ctx) =>
      properties.startBulkAction(
        ctx,
        StartListingBulkBody.parse({ action: { type: 'PRICE_CHANGE', percentBp: 500 }, target: { ids: ids_ } }),
      ),
    );
    await properties.propertiesJobs.runBulkAction.spec.run(
      { bulkActionId: bulk.id, agencyId: a.agencyId, userId: a.userId },
      jobCtx(),
    );
    expect((await as(a, (ctx) => properties.getBulkAction(ctx, bulk.id))).succeeded).toBe(1_000);
    const updates = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events
           where agency_id = ${a.agencyId} and type = 'properties.listing.updated' and processed_at is null
             and payload->'changed' = '["price"]'::jsonb`,
    );
    expect(updates[0]?.n).toBeGreaterThanOrEqual(1_000);
    const mine = new Set(ids_);
    const queued = await deliver(a);
    expect(queued.filter(([payload]) => mine.has((payload as { listingId: string }).listingId))).toEqual([]);
    // an edit the score reads still recomputes
    expect(quality.scoreMayChange(['price', 'energyRating'])).toBe(true);
    expect(quality.scoreMayChange(['price', 'owner', 'tags', 'visibility', 'shareScope'])).toBe(false);
    await system((tx) => tx.execute(sql`delete from properties where ref like ${`QB-${RUN}-%`}`));
  }, 300_000);
});

describe('listing freshness', () => {
  const sweep = () => properties.propertiesJobs.sweepFreshness.spec.run({}, jobCtx());
  const backdate = (id: string, days: number) =>
    system((tx) =>
      tx.execute(
        sql`update properties set last_confirmed_at = now() - make_interval(days => ${days}) where id = ${id}`,
      ),
    );
  const eventsOf = (id: string) =>
    rows<{ type: string }>(sql`select type from outbox_events where payload->>'listingId' = ${id} order by id`).then(
      (r) => r.map((e) => e.type),
    );

  it('[S3-08] a listing unconfirmed for 120 days disappears from network search but stays visible to its owner', async () => {
    const [stale, due, secret] = [await createListing(a), await createListing(a), await createListing(a)];
    for (const id of [stale, due]) {
      await as(a, (ctx) => properties.updateListing(ctx, id, { version: 1, status: 'ACTIVE', visibility: 'SHARED' }));
    }
    const privateOne = await as(a, (ctx) => properties.updateListing(ctx, secret, { version: 1, status: 'ACTIVE' }));
    expect(await networkView(b, stale)).toBe('visible');
    await backdate(stale, 121);
    await backdate(due, 95);
    await backdate(secret, 121);
    const before = { stale: await eventsOf(stale), due: await eventsOf(due), secret: await eventsOf(secret) };

    await sweep();
    await sweep(); // idempotent: nothing is hidden or prompted twice

    // Unconfirmed for 120 days: gone from the network (B's reads and B's network queries)…
    expect(await networkView(b, stale)).toBe('LISTING_NOT_FOUND');
    const seenByB = await withTenant({ agencyId: b.agencyId, userId: b.userId }, async (tx) =>
      (await tx.execute(sql`select id from properties where id in (${stale}, ${due})`)).rows.map((r) => r.id),
    );
    expect(seenByB).toEqual([due]);
    // …while its owner still opens it, sees why, and finds it in the agency's list.
    const own = await as(a, (ctx) => properties.getListing(ctx, stale));
    expect(own.freshness?.networkHiddenAt).not.toBeNull();
    expect(own.status).toBe('ACTIVE');
    expect(own.visibility).toBe('SHARED');
    const list = await as(a, (ctx) => properties.listListings(ctx, ListListingsQuery.parse({ limit: 100 })));
    expect(list.items.map((i) => i.id)).toContain(stale);
    expect((await eventsOf(stale)).slice(before.stale.length)).toEqual([
      'properties.listing.updated',
      'properties.listing.visibilityChanged',
      'properties.listing.confirmationDue',
    ]);

    // A private listing only gets the flag: no version bump (an open editor keeps saving), no network event.
    const flagged = await as(a, (ctx) => properties.getListing(ctx, secret));
    expect(flagged.freshness?.networkHiddenAt).not.toBeNull();
    expect(flagged.version).toBe(privateOne.version);
    expect((await eventsOf(secret)).slice(before.secret.length)).toEqual(['properties.listing.confirmationDue']);

    // 90 days: prompted once, still on the network.
    expect(await networkView(b, due)).toBe('visible');
    expect((await eventsOf(due)).slice(before.due.length)).toEqual(['properties.listing.confirmationDue']);
    expect((await as(a, (ctx) => quality.getListingQuality(ctx, due))).hints.map((h) => h.code)).toContain(
      'CONFIRMATION_DUE',
    );

    // The confirm button brings it back at once and restarts the clock.
    const confirmed = await as(a, (ctx) => properties.confirmListing(ctx, stale));
    expect(confirmed.freshness?.networkHiddenAt).toBeNull();
    expect(Date.now() - Date.parse(confirmed.freshness?.lastConfirmedAt ?? '')).toBeLessThan(60_000);
    expect(await networkView(b, stale)).toBe('visible');
    expect(await refusal(as(b, (ctx) => properties.confirmListing(ctx, stale)))).toBe('FORBIDDEN');
    // Safe to repeat (no version: the sweep may have moved the one an open editor holds).
    const again = await as(a, (ctx) => properties.confirmListing(ctx, stale));
    expect(again.version).toBe(confirmed.version + 1);
  });

  it('[S3-08] going ACTIVE again confirms the listing', async () => {
    const id = await createListing(a);
    await as(a, (ctx) => properties.updateListing(ctx, id, { version: 1, status: 'ACTIVE', visibility: 'SHARED' }));
    await backdate(id, 130);
    await sweep();
    const hidden = await as(a, (ctx) => properties.getListing(ctx, id));
    expect(hidden.freshness?.networkHiddenAt).not.toBeNull();
    const withdrawn = await as(a, (ctx) =>
      properties.updateListing(ctx, id, { version: hidden.version, status: 'WITHDRAWN' }),
    );
    const back = await as(a, (ctx) =>
      properties.updateListing(ctx, id, { version: withdrawn.version, status: 'ACTIVE' }),
    );
    expect(back.freshness?.networkHiddenAt).toBeNull();
    expect(await networkView(b, id)).toBe('visible');
  });
});
