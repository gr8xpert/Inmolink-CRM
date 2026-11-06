import { fileURLToPath } from 'node:url';
import { CreateListingBody, PutListingTranslationBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureAi, createAiGateway, filePromptSource } from '@inmolink/platform/ai';
import { FakeEmbeddingProvider, memoryAiStore } from '@inmolink/platform/ai/testing';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import { nearestListings } from '../embeddings';
import * as search from '../index';
import * as repo from '../repo';

/**
 * Listing embeddings on the real database (R2-01a): the gateway on a deterministic fake embedding provider, read
 * models built directly. Checks the hash skip, re-embedding on a text or model change, degrading on the budget,
 * the backfill walk, vectors dropped with their read model and the kNN over the HNSW index.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-emb-${RUN}`;
const PROMPTS_DIR = fileURLToPath(new URL('../../../../prompts', import.meta.url));
const log = createLogger({ service: 'embeddings-int', level: 'silent' });

let a: Founder;
let ids: { city: string; type: string };
let hardCap = 2e12;

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('search.embeddings.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const build = (id: string) => system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
const embed = (listingIds: string[]) => search.embedListings({ agencyId: a.agencyId, listingIds });

function gateway(model = 'fake-embed-model', dimensions = 1024, priced = true): FakeEmbeddingProvider {
  const provider = new FakeEmbeddingProvider(model, dimensions);
  configureAi(
    createAiGateway({
      provider: null,
      embeddings: provider,
      models: null,
      pricing: priced ? { [model]: { input: 0.02, output: 0 } } : {},
      batchDiscountBp: 5_000,
      prompts: filePromptSource(PROMPTS_DIR),
      cache: null,
      cacheTtlSeconds: 3_600,
      store: memoryAiStore(),
      budgetFor: () => ({ softMicroUsd: hardCap, hardMicroUsd: hardCap }),
      timeoutMs: 5_000,
      breaker: { failures: 1_000, openMs: 1_000 },
      logger: log,
    }),
  );
  return provider;
}

const version = async (id: string) => (await as((ctx) => properties.getListing(ctx, id))).version;
async function listing(title: string, description: string, extra: Partial<CreateListingBody> = {}): Promise<string> {
  const { id } = await as((ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.city, priceCents: 45_000_000, ...extra }),
    ),
  );
  await describeListing(id, title, description);
  await as(async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ status: 'ACTIVE', visibility: 'SHARED', version: await version(id) }),
    ),
  );
  await build(id);
  return id;
}
const describeListing = async (id: string, title: string, description: string) =>
  as(async (ctx) =>
    properties.saveListingTranslation(
      ctx,
      id,
      'en',
      PutListingTranslationBody.parse({ version: await version(id), title, description }),
    ),
  );
const stored = (id: string) =>
  rows<{ content_hash: string; source_version: number; model: string }>(
    sql`select content_hash, source_version, model from listing_embeddings where target_id = ${id}`,
  );

beforeAll(async () => {
  await setupTestDb('worker');
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: [{ locale: 'en', name: `Embedland ${RUN}`, slug: code('embedland') }],
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: [{ locale: 'en', name: `Northvec ${RUN}`, slug: code('northvec') }],
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: [{ locale: 'en', name: `Vectorton ${RUN}`, slug: code('vectorton') }],
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('houses'),
      sort: 0,
      translations: [{ locale: 'en', name: `Houses ${RUN}`, slug: code('houses') }],
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('villa'),
      sort: 0,
      translations: [{ locale: 'en', name: `Villa ${RUN}`, slug: code('villa') }],
    });
    return { city, type };
  });
}, 120_000);

afterAll(async () => {
  configureAi(undefined);
  await system(async (tx) => {
    await tx.execute(sql`delete from listing_embeddings where owner_agency_id = ${a.agencyId}`);
    await tx.execute(sql`delete from read_model_queue where owner_agency_id = ${a.agencyId}`);
    await tx.execute(sql`delete from search_index_queue where target_id in (
      select id from properties where agency_id = ${a.agencyId})`);
    await tx.execute(sql`delete from listing_search_docs where owner_agency_id = ${a.agencyId}`);
    await tx.execute(sql`delete from listing_read_models where agency_id = ${a.agencyId}`);
    await tx.execute(sql`delete from properties where agency_id = ${a.agencyId}`);
  });
  await closeDb();
});

describe('listing embedding text', () => {
  it('[R2-01] facts and text, never the price or the reference; whitespace-only edits give the same text', () => {
    const doc = {
      title: 'Sea  view villa',
      description: 'Bright villa\n\nwith a pool.',
      transactionType: 'SALE' as const,
      propertyType: { id: newId(), name: 'Villa', slug: 'villa' },
      place: { country: null, region: null, city: { id: newId(), name: 'Nerja', slug: 'nerja' }, area: null },
      bedrooms: 4,
      bathrooms: 3,
      builtM2: 320,
      features: [
        { id: newId(), name: 'Pool', slug: 'pool' },
        { id: newId(), name: 'Garden', slug: 'garden' },
      ],
    };
    const text = search.listingEmbeddingText(doc);
    expect(text).toBe(
      'Sea view villa\nVilla, sale\nNerja\n4 bedrooms, 3 bathrooms, 320 m² built\nFeatures: Garden, Pool\nBright villa with a pool.',
    );
    expect(search.listingEmbeddingText({ ...doc, description: 'Bright villa with a   pool. ' })).toBe(text);
    expect(search.listingEmbeddingText({ ...doc, description: 'x'.repeat(10_000) }).length).toBe(
      search.EMBED_TEXT_MAX_CHARS,
    );
    expect(search.embeddingHash('m1', text)).not.toBe(search.embeddingHash('m2', text));
  });

  it('[R2-01] contact details typed into the texts never reach the provider', () => {
    const text = search.listingEmbeddingText({
      title: 'Villa — call +34 600 123 456',
      description: 'Mail owner.juan@example.com or see www.juan-villas.example for a viewing. Pool and garden.',
    });
    expect(text).not.toMatch(/600 ?123 ?456|owner\.juan@example\.com|juan-villas/);
    expect(text).toContain('Pool and garden.');
  });
});

describe('listing embeddings', () => {
  it('[R2-01] unchanged listings are never re-embedded (price edit, re-run, rebuild); a text or model change is', async () => {
    const provider = gateway();
    const villa = await listing(`Sea view villa ${RUN}`, 'Bright villa with a pool and sea views.');
    const flat = await listing(`City flat ${RUN}`, 'Compact flat near the station.');

    const first = await embed([villa, flat]);
    expect(first).toMatchObject({ embedded: 2, unchanged: 0, degraded: 0 });
    expect(provider.texts).toBe(2);
    const [before] = await stored(villa);

    // a re-run (a redelivered event) and a price edit + rebuild: hash unchanged, no model call, version moves on
    expect(await embed([villa, flat])).toMatchObject({ embedded: 0, unchanged: 2 });
    await as(async (ctx) =>
      properties.updateListing(
        ctx,
        villa,
        UpdateListingBody.parse({ priceCents: 39_900_000, version: await version(villa) }),
      ),
    );
    await build(villa);
    expect(await embed([villa])).toMatchObject({ embedded: 0, unchanged: 1 });
    expect(provider.texts).toBe(2);
    const [afterPrice] = await stored(villa);
    expect(afterPrice?.content_hash).toBe(before?.content_hash);
    expect(afterPrice?.source_version).toBeGreaterThan(before?.source_version ?? 0);
    // the backfill finds nothing stale for them either
    expect(await search.embeddingBackfillPage({ agencyId: a.agencyId, after: null })).toMatchObject({
      embedded: 0,
      next: null,
    });
    expect(provider.texts).toBe(2);

    // a description edit re-embeds that listing only
    await describeListing(villa, `Sea view villa ${RUN}`, 'Bright villa with a pool, sea views and a guest house.');
    await build(villa);
    expect(await embed([villa, flat])).toMatchObject({ embedded: 1, unchanged: 1 });
    expect(provider.texts).toBe(3);
    expect((await stored(villa))[0]?.content_hash).not.toBe(before?.content_hash);

    // another model: every listing is stale for the backfill, embedded once, then never again
    const next = gateway('fake-embed-model-2');
    expect(await search.embeddingBackfillPage({ agencyId: a.agencyId, after: null })).toMatchObject({ embedded: 2 });
    expect(await search.embeddingBackfillPage({ agencyId: a.agencyId, after: null })).toMatchObject({ embedded: 0 });
    expect(next.texts).toBe(2);
    expect((await stored(flat))[0]?.model).toBe('fake-embed-model-2');

    // a read model rewritten at the same version (a place or type rename): no event, but the backfill sees the newer
    // write and re-embeds that listing only
    await rows(sql`update listing_read_models set detail = jsonb_set(detail, '{title}', to_jsonb(${`Renamed flat ${RUN}`}::text)),
                     updated_at = now() where target_id = ${flat}`);
    expect(await search.embeddingBackfillPage({ agencyId: a.agencyId, after: null })).toMatchObject({ embedded: 1 });
    expect(next.calls.at(-1)?.[0]).toContain(`Renamed flat ${RUN}`);
    expect(await search.embeddingBackfillPage({ agencyId: a.agencyId, after: null })).toMatchObject({ embedded: 0 });
  });

  it('[R2-01] writes never go backwards: an older job finishing late, or an older touch, keeps the newer row', async () => {
    gateway();
    const id = await listing(`Race villa ${RUN}`, 'Villa written by two jobs.');
    await embed([id]);
    const [now] = await stored(id);
    const row = await rows<{ source_updated_at: string }>(
      sql`select source_updated_at::text from listing_embeddings where target_id = ${id}`,
    );
    const at = row[0]?.source_updated_at ?? '';
    const older = {
      targetId: id,
      ownerAgencyId: a.agencyId,
      embedding: new Array<number>(1024).fill(0.01),
      model: 'fake-embed-model',
      contentHash: 'older',
      sourceVersion: (now?.source_version ?? 2) - 1,
      sourceUpdatedAt: at,
    };
    expect(await system((tx) => repo.upsertEmbeddings(tx, [older]))).toBe(0);
    expect(
      await system((tx) =>
        repo.upsertEmbeddings(tx, [
          { ...older, sourceVersion: now?.source_version ?? 1, sourceUpdatedAt: '2000-01-01T00:00:00Z' },
        ]),
      ),
    ).toBe(0);
    await system((tx) => repo.touchEmbeddings(tx, [{ targetId: id, version: 1, updatedAt: '2000-01-01T00:00:00Z' }]));
    expect(await stored(id)).toEqual([now]);
  });

  it('[R2-01] an orphan vector (its drop event lost) is removed by the backfill', async () => {
    gateway();
    const id = await listing(`Orphan villa ${RUN}`, 'Villa whose drop event was lost.');
    await embed([id]);
    await rows(sql`delete from listing_read_models where target_id = ${id}`);
    const page = await search.embeddingBackfillPage({ agencyId: a.agencyId, after: null });
    expect(page.deleted).toBeGreaterThanOrEqual(1);
    expect(await stored(id)).toEqual([]);
  });

  it('[R2-01] the backfill pages by a fixed window; the sweep queues one walk per agency, with stable job ids', async () => {
    gateway();
    const first = await search.embeddingBackfillPage({ agencyId: a.agencyId, after: null }, { window: 1 });
    expect(first.next).not.toBeNull();
    const second = await search.embeddingBackfillPage({ agencyId: a.agencyId, after: first.next }, { window: 1 });
    expect(second.next === null || (second.next ?? '') > (first.next ?? '')).toBe(true);
    expect(search.embeddingBackfillKey({ run: '2026-11-06', agencyId: a.agencyId, after: null })).toBe(
      `emb.2026-11-06.${a.agencyId}.start`,
    );

    const queued: unknown[] = [];
    const many = vi
      .spyOn(search.embeddingJobs.embeddingsBackfill, 'enqueueMany')
      .mockImplementation(async (entries) => {
        queued.push(...entries.map((e) => e.payload));
        return entries.map(() => ({ id: 'test' }));
      });
    try {
      const job = search.embeddingJobs.embeddingsSweep;
      await job.spec.run(
        {},
        { log, jobId: newId(), attempt: 1, progress: async () => {}, signal: new AbortController().signal },
      );
    } finally {
      many.mockRestore();
    }
    expect(queued).toContainEqual({
      run: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      agencyId: a.agencyId,
      after: null,
    });
  });

  it('[R2-01] over budget: nothing is written, the backfill embeds the listing later', async () => {
    const provider = gateway();
    const id = await listing(`Budget cottage ${RUN}`, 'Stone cottage in the hills.');
    hardCap = 0;
    try {
      expect(await embed([id])).toMatchObject({ embedded: 0, degraded: 1, degradeCode: 'AI_BUDGET_EXCEEDED' });
      expect(await stored(id)).toEqual([]);
      const page = await search.embeddingBackfillPage({ agencyId: a.agencyId, after: null });
      expect(page.degraded).toBeGreaterThan(0);
      expect(page).toMatchObject({ embedded: 0, next: null });
    } finally {
      hardCap = 2e12;
    }
    // (the earlier test's listings are stale too: they were embedded by another model)
    const page = await search.embeddingBackfillPage({ agencyId: a.agencyId, after: null });
    expect(page).toMatchObject({ degraded: 0, next: null });
    expect(page.embedded).toBeGreaterThan(0);
    expect(provider.calls.flat().filter((t) => t.includes(`Budget cottage ${RUN}`))).toHaveLength(1);
    expect(await stored(id)).toHaveLength(1);
  });

  it('[R2-01] off: nothing read or called; a provider of another size is refused', async () => {
    configureAi(undefined);
    expect(await embed([newId()])).toMatchObject({ disabled: true, embedded: 0 });
    gateway('fake-embed-small', 256);
    await expect(embed([newId()])).rejects.toMatchObject({ code: 'INTERNAL', details: { reason: 'EMBED_DIMENSIONS' } });
    // an unpriced model would never meet the budget cap: the gateway refuses it, nothing is written
    const unpriced = gateway('fake-embed-unpriced', 1024, false);
    const id = await listing(`Unpriced villa ${RUN}`, 'Villa of an unpriced model.');
    expect(await embed([id])).toMatchObject({ embedded: 0, degraded: 1, degradeCode: 'AI_UNAVAILABLE' });
    expect(unpriced.texts).toBe(0);
  });

  it('[R2-01] a listing without a read model loses its vector', async () => {
    gateway();
    const id = await listing(`Withdrawn house ${RUN}`, 'House taken off the market.');
    await embed([id]);
    expect(await stored(id)).toHaveLength(1);
    await as(async (ctx) =>
      properties.updateListing(ctx, id, UpdateListingBody.parse({ visibility: 'PRIVATE', version: await version(id) })),
    );
    await build(id);
    expect(await rows(sql`select 1 from listing_read_models where target_id = ${id}`)).toEqual([]);
    expect(await embed([id])).toMatchObject({ deleted: 1 });
    expect(await stored(id)).toEqual([]);
  });

  it('[R2-01] a read-model change queues one embedding job per event', async () => {
    gateway();
    const id = await listing(`Queued villa ${RUN}`, 'Villa queued for its embedding.');
    const queued: unknown[] = [];
    const spy = vi.spyOn(search.embeddingJobs.embedListings, 'enqueue').mockImplementation(async (p) => {
      queued.push(p);
      return { id: 'test' };
    });
    search.registerEmbeddingSubscriptions();
    try {
      const events = await rows<{ id: string; payload: { listingIds: string[] }; version: number }>(
        sql`select id, payload, version from outbox_events
             where agency_id = ${a.agencyId} and type = 'search.listings.changed' and payload->'listingIds' ? ${id}`,
      );
      expect(events.length).toBeGreaterThan(0);
      const e = events.at(-1);
      if (!e) throw new Error('no event');
      const meta = {
        eventId: e.id,
        agencyId: a.agencyId,
        type: 'search.listings.changed',
        version: e.version,
        createdAt: new Date(),
        attempt: 1,
      };
      for (const s of defaultSubscribers.get('search.listings.changed', e.version)) {
        if (s.name === 'search.embeddings.listingsChanged') await s.handler(e.payload as never, meta);
      }
    } finally {
      search.unregisterEmbeddingSubscriptions();
      spy.mockRestore();
    }
    expect(queued).toEqual([
      { eventId: expect.any(String), agencyId: a.agencyId, listingIds: expect.arrayContaining([id]) },
    ]);
    expect(search.embeddingJobs.embedListings.spec.jobId?.(queued[0] as never)).toMatch(/^emb\./);
  });

  it('[R2-01] kNN answers the nearest listings first, over the HNSW index', async () => {
    gateway();
    const pool = await listing(`Pool villa ${RUN}`, 'Detached villa, private pool, sea views, garden.');
    const studio = await listing(`Studio ${RUN}`, 'Small studio apartment, city centre, near the metro.');
    await embed([pool, studio]);
    const probe = new FakeEmbeddingProvider();
    const query = (await probe.embed(['villa with private pool and sea views garden'])).vectors[0] ?? [];
    const hits = await system((tx) => nearestListings(tx, query, 100));
    const order = hits.map((h) => h.targetId).filter((t) => t === pool || t === studio);
    expect(order).toEqual([pool, studio]);
    expect(hits[0]?.distance ?? 1).toBeLessThanOrEqual(hits.at(-1)?.distance ?? 0);

    const plan = await system(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const literal = `[${query.join(',')}]`;
      const res = await tx.execute(sql`explain select target_id from listing_embeddings
        order by embedding <=> ${literal}::halfvec limit 20`);
      return (res.rows as { 'QUERY PLAN': string }[]).map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('listing_embeddings_hnsw_idx');
    await expect(system((tx) => nearestListings(tx, [1, 2, 3]))).rejects.toBeInstanceOf(AppError);
    await expect(system((tx) => nearestListings(tx, new Array<number>(1024).fill(Number.NaN)))).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
