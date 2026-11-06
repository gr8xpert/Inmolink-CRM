import { fileURLToPath } from 'node:url';
import { closeDb, withSystem } from '@inmolink/db';
import { CLIENT_PROFILE_EMBEDDING_DIMENSIONS } from '@inmolink/db/schema/matching';
import { setupTestDb } from '@inmolink/db/testing';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { configureAi, createAiGateway, filePromptSource } from '@inmolink/platform/ai';
import { FakeEmbeddingProvider, memoryAiStore } from '@inmolink/platform/ai/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as matching from '../index';
import * as repo from '../repo';

/**
 * Client-profile embeddings on the real database (R2-01b): the gateway on a deterministic fake embedding provider,
 * profiles written directly (their service comes with R2-02). Checks the text (criteria as words, no price, contact
 * details removed), the hash skip, re-embedding on a text, taxonomy-name or model change, OFF / deleted profiles
 * losing their vector, the backfill walk with its orphan sweep, degrading on the budget and the event → job wiring.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-pemb-${RUN}`;
const PROMPTS_DIR = fileURLToPath(new URL('../../../../prompts', import.meta.url));
const log = createLogger({ service: 'profile-embeddings-int', level: 'silent' });
const L = FALLBACK_CONTENT_LOCALE;

let a: Founder;
let ids: { city: string; type: string; pool: string };
let hardCap = 2e12;

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('matching.profileEmbeddings.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const embed = (profileIds: string[]) => matching.embedProfiles({ agencyId: a.agencyId, profileIds });

function gateway(model = 'fake-embed-model', dimensions = 1024): FakeEmbeddingProvider {
  const provider = new FakeEmbeddingProvider(model, dimensions);
  configureAi(
    createAiGateway({
      provider: null,
      embeddings: provider,
      models: null,
      pricing: { [model]: { input: 0.02, output: 0 } },
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

/** A profile row as R2-02's service will write it. */
async function profile(wishes: string, extra: { mode?: string; priceMaxCents?: number } = {}): Promise<string> {
  const id = newId();
  await rows(sql`
    insert into client_profiles (id, agency_id, contact_id, mode, transaction_type, property_type_ids, location_ids,
                                 feature_ids, price_max_cents, beds_min, wishes)
    values (${id}, ${a.agencyId}, ${newId()}, ${extra.mode ?? 'REVIEW'}, 'SALE', array[${ids.type}]::uuid[],
            array[${ids.city}]::uuid[], array[${ids.pool}]::uuid[], ${extra.priceMaxCents ?? 60_000_000}, 3, ${wishes})`);
  return id;
}
const change = (id: string, set: ReturnType<typeof sql>) =>
  rows(sql`update client_profiles set ${set}, version = version + 1, updated_at = now() where id = ${id}`);
const stored = (id: string) =>
  rows<{ content_hash: string; source_version: number; model: string }>(
    sql`select content_hash, source_version, model from client_profile_embeddings where profile_id = ${id}`,
  );
const sent = (provider: FakeEmbeddingProvider, marker: string) =>
  provider.calls.flat().filter((t) => t.includes(marker)).length;

beforeAll(async () => {
  await setupTestDb('worker');
  a = await createFounder();
  ids = await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: [{ locale: L, name: `Profiland ${RUN}`, slug: code('profiland') }],
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: [{ locale: L, name: `Wantshire ${RUN}`, slug: code('wantshire') }],
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: [{ locale: L, name: `Wishton ${RUN}`, slug: code('wishton') }],
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('houses'),
      sort: 0,
      translations: [{ locale: L, name: `Houses ${RUN}`, slug: code('houses') }],
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('villa'),
      sort: 0,
      translations: [{ locale: L, name: `Villa ${RUN}`, slug: code('villa') }],
    });
    const featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: code('outdoor'),
      sort: 0,
      translations: [{ locale: L, name: `Outdoor ${RUN}`, slug: code('outdoor') }],
    });
    const pool = await taxonomy.createFeature(tx, {
      groupId: featureGroup,
      key: code('pool'),
      sort: 0,
      icon: 'pool',
      translations: [{ locale: L, name: `Pool ${RUN}`, slug: code('pool') }],
    });
    return { city, type, pool };
  });
}, 120_000);

afterAll(async () => {
  configureAi(undefined);
  await system(async (tx) => {
    await tx.execute(sql`delete from client_profile_embeddings where owner_agency_id = ${a.agencyId}`);
    await tx.execute(sql`delete from client_profiles where agency_id = ${a.agencyId}`);
  });
  await closeDb();
});

describe('client-profile embedding text', () => {
  const names = {
    name: (id: string) => ({ t1: 'Villa', t2: 'Apartment', f1: 'Sea views', f2: 'Pool' })[id] ?? null,
    place: (id: string) => (id === 'l1' ? ['Nerja', 'Málaga', 'Spain'] : id === 'l2' ? ['Frigiliana'] : []),
  };
  const facts = {
    transactionType: 'SALE',
    propertyTypeIds: ['t1', 't2'],
    locationIds: ['l2', 'l1'],
    featureIds: ['f1', 'f2'],
    bedsMin: 3,
    bathsMin: 2,
    areaMinM2: 120,
    areaMaxM2: 250.5,
    wishes: 'Quiet  street,\nwalk to the beach.',
  };

  it('[R2-01] criteria as sorted words then the wishes — never the price; the order ids were picked in is no change', () => {
    const text = matching.profileEmbeddingText(facts, names);
    expect(text).toBe(
      [
        'Looking to buy',
        'Property types: Apartment; Villa',
        'Places: Frigiliana; Nerja, Málaga, Spain',
        'at least 3 bedrooms, at least 2 bathrooms, 120–250.5 m²',
        'Must have: Pool, Sea views',
        'Quiet street, walk to the beach.',
      ].join('\n'),
    );
    const shuffled = { ...facts, propertyTypeIds: ['t2', 't1'], locationIds: ['l1', 'l2'], featureIds: ['f2', 'f1'] };
    expect(matching.profileEmbeddingText(shuffled, names)).toBe(text);
    expect(matching.profileEmbeddingText({ ...facts, wishes: 'x'.repeat(10_000) }, names).length).toBe(
      search.EMBED_TEXT_MAX_CHARS,
    );
    expect(
      matching.profileEmbeddingText(
        { ...facts, transactionType: null, propertyTypeIds: [], locationIds: [], featureIds: [], wishes: null },
        names,
      ),
    ).toBe('Looking for a property\nat least 3 bedrooms, at least 2 bathrooms, 120–250.5 m²');
  });

  it('[R2-01] contact details in the wishes never reach the provider', () => {
    const text = matching.profileEmbeddingText(
      { ...facts, wishes: 'Call me on +34 600 123 456 or juan.buyer@example.com. Big garden please.' },
      names,
    );
    expect(text).not.toMatch(/600 ?123 ?456|juan\.buyer@example\.com/);
    expect(text).toContain('Big garden please.');
  });

  it('[R2-01] a profile vector lives in the listing vectors’ space (same size)', () => {
    expect(CLIENT_PROFILE_EMBEDDING_DIMENSIONS).toBe(search.EMBEDDING_DIMENSIONS);
  });
});

describe('client-profile embeddings', () => {
  it('[R2-01] unchanged profiles are never re-embedded (budget edit, re-run, backfill); a wishes change is', async () => {
    const provider = gateway();
    const p = await profile(`Sea views, quiet ${RUN}`);
    expect(await embed([p])).toMatchObject({ embedded: 1, unchanged: 0, degraded: 0 });
    const [before] = await stored(p);
    expect(before?.source_version).toBe(1);

    // a redelivered event, a budget edit (new version) and the backfill walk: no model call, the version moves on
    expect(await embed([p])).toMatchObject({ embedded: 0, unchanged: 1 });
    await change(p, sql`price_max_cents = 55000000`);
    expect(await embed([p])).toMatchObject({ embedded: 0, unchanged: 1 });
    expect(await matching.profileBackfillPage({ agencyId: a.agencyId, after: null })).toMatchObject({
      embedded: 0,
      next: null,
    });
    expect(sent(provider, `Sea views, quiet ${RUN}`)).toBe(1);
    const [afterBudget] = await stored(p);
    expect(afterBudget).toMatchObject({ content_hash: before?.content_hash, source_version: 2 });

    // the wishes change: embedded again
    await change(p, sql`wishes = ${`Sea views, quiet, near a golf course ${RUN}`}`);
    expect(await embed([p])).toMatchObject({ embedded: 1, unchanged: 0 });
    const [afterWishes] = await stored(p);
    expect(afterWishes?.content_hash).not.toBe(before?.content_hash);
    expect(afterWishes?.source_version).toBe(3);
  });

  it('[R2-01] a taxonomy rename or a model switch (same version, other text) is re-embedded by the backfill', async () => {
    const provider = gateway();
    const p = await profile(`Rename watcher ${RUN}`);
    await embed([p]);
    const [before] = await stored(p);
    await rows(sql`update property_type_translations set name = ${`Country villa ${RUN}`}
                    where type_id = ${ids.type} and locale = ${L}`);
    expect((await matching.profileBackfillPage({ agencyId: a.agencyId, after: null })).embedded).toBeGreaterThan(0);
    const [renamed] = await stored(p);
    expect(renamed?.content_hash).not.toBe(before?.content_hash);
    expect(renamed?.source_version).toBe(before?.source_version);
    expect(
      provider.calls.flat().some((t) => t.includes(`Country villa ${RUN}`) && t.includes(`Rename watcher ${RUN}`)),
    ).toBe(true);

    gateway('fake-embed-model-2');
    await matching.profileBackfillPage({ agencyId: a.agencyId, after: null });
    expect((await stored(p))[0]?.model).toBe('fake-embed-model-2');
  });

  it('[R2-01] writes never go backwards: an older job finishing late, or an older touch, keeps the newer row', async () => {
    gateway();
    const p = await profile(`Out of order ${RUN}`);
    const vec = new Array(CLIENT_PROFILE_EMBEDDING_DIMENSIONS).fill(0.01);
    const row = (version: number, hash: string) => ({
      profileId: p,
      ownerAgencyId: a.agencyId,
      embedding: vec,
      model: 'fake-embed-model',
      contentHash: hash,
      sourceVersion: version,
    });
    await system((tx) => repo.upsertProfileEmbeddings(tx, [row(3, 'h3')]));
    expect(await system((tx) => repo.upsertProfileEmbeddings(tx, [row(2, 'h2')]))).toBe(0);
    await system((tx) => repo.touchProfileEmbeddings(tx, [{ profileId: p, version: 2 }]));
    expect((await stored(p))[0]).toMatchObject({ content_hash: 'h3', source_version: 3 });
    // the same version may be rewritten (a taxonomy rename or a model switch changes the text, not the version)
    expect(await system((tx) => repo.upsertProfileEmbeddings(tx, [row(3, 'h3b')]))).toBe(1);
    expect((await stored(p))[0]).toMatchObject({ content_hash: 'h3b', source_version: 3 });
  });

  it('[R2-01] OFF and deleted profiles lose their vector; the backfill drops orphans', async () => {
    gateway();
    const off = await profile(`Switched off ${RUN}`);
    const gone = await profile(`Deleted later ${RUN}`);
    const orphan = await profile(`Orphan ${RUN}`);
    await embed([off, gone, orphan]);
    expect((await stored(off)).length + (await stored(gone)).length + (await stored(orphan)).length).toBe(3);

    await change(off, sql`mode = 'OFF'`);
    await rows(sql`delete from client_profiles where id = ${gone}`);
    expect(await embed([off, gone])).toMatchObject({ deleted: 2, embedded: 0 });
    expect(await stored(off)).toEqual([]);
    expect(await stored(gone)).toEqual([]);
    // an OFF profile is never embedded
    const quiet = await profile(`Never on ${RUN}`, { mode: 'OFF' });
    expect(await embed([quiet])).toMatchObject({ embedded: 0, unchanged: 0 });

    // the drop event was lost: the walk finds the vector without a profile
    await rows(sql`delete from client_profiles where id = ${orphan}`);
    expect((await matching.profileBackfillPage({ agencyId: a.agencyId, after: null })).deleted).toBeGreaterThan(0);
    expect(await stored(orphan)).toEqual([]);
  });

  it('[R2-01] the backfill pages by a fixed window and the sweep queues one walk per agency', async () => {
    gateway();
    await profile(`Window one ${RUN}`);
    await profile(`Window two ${RUN}`);
    const all = await rows<{ id: string }>(
      sql`select id from client_profiles where agency_id = ${a.agencyId} order by id`,
    );
    const first = await matching.profileBackfillPage({ agencyId: a.agencyId, after: null }, { window: 1 });
    expect(first.next).toBe(all[0]?.id);
    const last = await matching.profileBackfillPage(
      { agencyId: a.agencyId, after: all.at(-2)?.id ?? null },
      { window: 1 },
    );
    expect(last.next).toBe(all.at(-1)?.id);
    expect(
      (await matching.profileBackfillPage({ agencyId: a.agencyId, after: all.at(-1)?.id ?? null }, { window: 1 })).next,
    ).toBeNull();

    const queued: unknown[] = [];
    const spy = vi
      .spyOn(matching.profileEmbeddingJobs.profileEmbeddingsBackfill, 'enqueueMany')
      .mockImplementation(async (entries) => {
        queued.push(...entries.map((e) => e.payload));
        return entries.map(() => ({ id: 'test' }));
      });
    try {
      await matching.profileEmbeddingJobs.profileEmbeddingsSweep.spec.run(
        {},
        { log, jobId: newId(), attempt: 1, progress: async () => {}, signal: new AbortController().signal },
      );
    } finally {
      spy.mockRestore();
    }
    expect(queued).toContainEqual({
      run: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      agencyId: a.agencyId,
      after: null,
    });
    expect(matching.profileBackfillKey({ run: '2026-11-06', agencyId: a.agencyId, after: null })).toBe(
      `pemb.2026-11-06.${a.agencyId}.start`,
    );
  });

  it('[R2-01] over budget: nothing is written, the backfill embeds the profile later', async () => {
    const provider = gateway();
    const p = await profile(`Budget buyer ${RUN}`);
    hardCap = 0;
    try {
      expect(await embed([p])).toMatchObject({ embedded: 0, degraded: 1, degradeCode: 'AI_BUDGET_EXCEEDED' });
      expect(await stored(p)).toEqual([]);
      expect(await matching.profileBackfillPage({ agencyId: a.agencyId, after: null })).toMatchObject({
        embedded: 0,
        next: null,
      });
    } finally {
      hardCap = 2e12;
    }
    expect((await matching.profileBackfillPage({ agencyId: a.agencyId, after: null })).degraded).toBe(0);
    expect(await stored(p)).toHaveLength(1);
    expect(sent(provider, `Budget buyer ${RUN}`)).toBe(1);
  });

  it('[R2-01] off: nothing read or called; a provider of another size is refused', async () => {
    configureAi(undefined);
    expect(await embed([newId()])).toMatchObject({ disabled: true, embedded: 0 });
    expect(await matching.profileBackfillPage({ agencyId: a.agencyId, after: null })).toMatchObject({
      disabled: true,
      next: null,
    });
    gateway('fake-embed-small', 256);
    await expect(embed([newId()])).rejects.toMatchObject({ code: 'INTERNAL', details: { reason: 'EMBED_DIMENSIONS' } });
  });

  it('[R2-01] a profile change event queues one embedding job', async () => {
    const queued: unknown[] = [];
    const spy = vi.spyOn(matching.profileEmbeddingJobs.embedProfiles, 'enqueue').mockImplementation(async (p) => {
      queued.push(p);
      return { id: 'test' };
    });
    matching.registerMatchingSubscriptions();
    const profileId = newId();
    try {
      const meta = {
        eventId: newId(),
        agencyId: a.agencyId,
        type: 'matching.clientProfiles.changed',
        version: 1,
        createdAt: new Date(),
        attempt: 1,
      };
      for (const s of defaultSubscribers.get('matching.clientProfiles.changed', 1)) {
        if (s.name === 'matching.profileEmbeddings') {
          await s.handler({ agencyId: a.agencyId, profileIds: [profileId] } as never, meta);
        }
      }
    } finally {
      matching.unregisterMatchingSubscriptions();
      spy.mockRestore();
    }
    expect(queued).toEqual([{ eventId: expect.any(String), agencyId: a.agencyId, profileIds: [profileId] }]);
    expect(matching.profileEmbeddingJobs.embedProfiles.spec.jobId?.(queued[0] as never)).toMatch(/^pemb\./);
  });

  it('[R2-01] agency erasure removes its client profiles and their vectors', async () => {
    gateway();
    const p = await profile(`Erased buyer ${RUN}`);
    await embed([p]);
    for (let i = 0; i < 20; i++) {
      if (!(await matching.deleteAgencySavedSearches({ agencyId: a.agencyId })).more) break;
    }
    expect(await rows(sql`select 1 from client_profiles where agency_id = ${a.agencyId}`)).toEqual([]);
    expect(await rows(sql`select 1 from client_profile_embeddings where owner_agency_id = ${a.agencyId}`)).toEqual([]);
  });
});
