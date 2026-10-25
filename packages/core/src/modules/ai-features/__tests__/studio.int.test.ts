import { fileURLToPath } from 'node:url';
import {
  CreateListingBody,
  LISTING_STUDIO_RUNNING_MAX,
  ListingStudioBody,
  ListingStudioBulkBody,
  PutListingTranslationBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureAi, createAiGateway, filePromptSource } from '@inmolink/platform/ai';
import { FakeProvider, memoryAiCache, memoryAiStore } from '@inmolink/platform/ai/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as aiFeatures from '../index';
import type { StudioInput } from '../studio-facts';

/**
 * AI Listing Studio (S12-02) against Postgres, the gateway answering from a fake provider (tests never call the real
 * one): request → job → AI_DRAFT translations, the fact check with its one repair, locked and reviewed locales, the
 * bulk batch path, stale facts and the AI_DRAFT → REVIEWED workflow.
 */

const PROMPTS_DIR = fileURLToPath(new URL('../../../../prompts', import.meta.url));
const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [
  { locale: 'en', name, slug: code(slug) },
  { locale: 'es', name: `${name} (es)`, slug: code(`${slug}-es`) },
];
const log = createLogger({ service: 'studio-test', level: 'silent' });

type Member = { userId: string; agencyId: string };
let owner: Founder;
let agent: Member;
let ids: { location: string; type: string; pool: string };

const as = <T>(m: Member, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string; details?: { field?: string } }) =>
      err.details?.field ? `${err.code}:${err.details.field}` : (err.code ?? String(err)),
  );
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('ai-features.studio.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** Behaviour of the fake model per call. */
type Mode = 'good' | 'invents' | 'always-invents' | 'quotes-price';
let mode: Mode = 'good';

function inputOf(user: string): StudioInput & { rejected?: string[] } {
  return JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1));
}

/** A model that writes copy from the facts (digits only from them), or invents a distance when told to. */
function copyFor(input: StudioInput & { rejected?: string[] }): string {
  const f = input.facts;
  const invent = mode === 'always-invents' || (mode === 'invents' && !input.rejected);
  const place = f.location[0] ?? 'Spain';
  const description = [
    `[${input.locale}/${input.tone}] ${f.propertyType} in ${place} with ${f.bedrooms} bedrooms and ${f.bathrooms} bathrooms.`,
    `It offers ${f.builtM2} m² built and a bright layout, with ${f.features.join(', ') || 'good finishes'}.`,
    mode === 'quotes-price'
      ? 'Yours for 450.000.'
      : invent
        ? 'Only 10 minutes from the beach.'
        : 'A home to enjoy all year round in a sought-after area.',
  ].join('\n\n');
  return JSON.stringify({
    title: `${f.propertyType} in ${place}`,
    description,
    metaTitle: `${f.propertyType} in ${place}`.slice(0, 60),
    metaDescription: `${f.propertyType} with ${f.bedrooms} bedrooms in ${place}: bright, well kept and ready to move in.`,
  });
}

let provider: FakeProvider;
function useGateway(): void {
  provider = new FakeProvider((request) => copyFor(inputOf(request.user)));
  configureAi(
    createAiGateway({
      provider,
      models: { FAST: 'fast-model', SMART: 'smart-model' },
      pricing: { 'fast-model': { input: 1, output: 5 }, 'smart-model': { input: 5, output: 25 } },
      batchDiscountBp: 5_000,
      prompts: filePromptSource(PROMPTS_DIR),
      cache: memoryAiCache(),
      cacheTtlSeconds: 3_600,
      store: memoryAiStore(),
      budgetFor: () => ({ softMicroUsd: 1e12, hardMicroUsd: 2e12 }),
      timeoutMs: 5_000,
      breaker: { failures: 1_000, openMs: 1_000 },
      logger: log,
    }),
  );
}

const create = (m: Member, body: Partial<CreateListingBody> = {}) =>
  as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.type,
        locationId: ids.location,
        bedrooms: 3,
        bathrooms: 2,
        builtM2: 145.5,
        ...body,
      }),
    ),
  );
const content = (m: Member, id: string) => as(m, (ctx) => properties.getListingContent(ctx, id));
const translate = (m: Member, id: string, locale: string, body: Record<string, unknown>) =>
  as(m, (ctx) => properties.saveListingTranslation(ctx, id, locale, PutListingTranslationBody.parse(body)));

/** The job payload the worker builds from the request's outbox event. */
async function requestOf(requestId: string): Promise<aiFeatures.StudioRequest & { mode: string }> {
  const [e] = await rows<{ payload: Record<string, unknown>; agency_id: string }>(
    sql`select payload, agency_id from outbox_events
        where type = 'aiFeatures.listingStudio.requested' and payload->>'requestId' = ${requestId}`,
  );
  if (!e) throw new Error('no request event');
  return { ...(e.payload as unknown as aiFeatures.StudioRequest & { mode: string }), agencyId: e.agency_id };
}
const single = async (m: Member, id: string, body: Record<string, unknown> = {}) =>
  requestOf((await as(m, (ctx) => aiFeatures.requestListingStudio(ctx, id, ListingStudioBody.parse(body)))).requestId);
const bulk = async (m: Member, listingIds: string[], body: Record<string, unknown> = {}) =>
  requestOf(
    (
      await as(m, (ctx) =>
        aiFeatures.requestListingStudioBulk(ctx, ListingStudioBulkBody.parse({ listingIds, ...body })),
      )
    ).requestId,
  );
const texts = async (m: Member, id: string) =>
  Object.fromEntries((await content(m, id)).translations.map((t) => [t.locale, t]));

beforeAll(async () => {
  await setupTestDb('worker');
  owner = await createFounder();
  await setAgencyStatus(owner.agencyId, 'VERIFIED');
  const agentId = newId();
  await system(async (tx) => {
    await tx.execute(
      sql`update agency_settings set enabled_locales = '{en,es,de}' where agency_id = ${owner.agencyId}`,
    );
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${owner.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`agent-${agentId}@example.com`})`);
  });
  agent = { userId: agentId, agencyId: owner.agencyId };
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('sc'),
      translations: tr(`Studioland ${RUN}`, 'studioland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('s-houses'),
      sort: 0,
      translations: tr('Houses', 's-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('s-villa'),
      sort: 0,
      translations: tr('Villa', 's-villa'),
    });
    const fgroup = await taxonomy.createFeatureGroup(tx, {
      key: code('s-outdoor'),
      sort: 0,
      translations: tr('Outdoor', 's-outdoor'),
    });
    const pool = await taxonomy.createFeature(tx, {
      groupId: fgroup,
      key: code('s-pool'),
      sort: 0,
      icon: 'waves',
      translations: tr('Private pool', 's-pool'),
    });
    return { location, type, pool };
  });
}, 120_000);

afterEach(() => {
  mode = 'good';
  configureAi(undefined);
});
afterAll(closeDb);

describe('AI Listing Studio (S12-02)', () => {
  it('[S12-02] a request queues a job; the job writes AI_DRAFT copy for every enabled locale from the facts', async () => {
    useGateway();
    const l = await create(owner);
    const req = await single(owner, l.id, { tone: 'WARM' });
    expect(req).toMatchObject({ mode: 'SINGLE', listingIds: [l.id], locales: ['en', 'es', 'de'], tone: 'WARM' });
    expect(provider.calls).toHaveLength(0); // nothing in the request

    const outcome = await aiFeatures.generateListingStudio(req);
    expect(outcome.written[l.id]?.sort()).toEqual(['de', 'en', 'es']);
    const t = await texts(owner, l.id);
    for (const locale of ['en', 'es', 'de']) {
      expect(t[locale]).toMatchObject({ origin: 'AI_DRAFT', locked: false });
      expect(t[locale]?.description).toContain(`[${locale}/WARM]`);
      expect(t[locale]?.description).toContain('3 bedrooms');
      expect(t[locale]?.description).toContain('145.5 m²');
    }
    // the model saw facts in the locale's names, never the price or the reference
    const seen = provider.calls.map((c) => inputOf(c.user));
    expect(seen.find((i) => i.locale === 'es')?.facts.propertyType).toBe('Villa (es)');
    expect(provider.calls.map((c) => c.user).join('\n')).not.toMatch(/priceCents|commission|ref"/);
    // one listing event for the three drafts
    const events = await rows<{ changed: string[] }>(
      sql`select payload->'changed' as changed from outbox_events
          where type = 'properties.listing.updated' and payload->>'listingId' = ${l.id}`,
    );
    expect(events.map((e) => e.changed)).toEqual([['translations']]);
  });

  it('[S12-02] numbers in generated text match listing facts: an invented figure is repaired once, else dropped', async () => {
    useGateway();
    const l = await create(owner);
    mode = 'invents';
    const repaired = await aiFeatures.generateListingStudio(await single(owner, l.id, { locales: ['en'] }));
    expect(repaired.written[l.id]).toEqual(['en']);
    const repairCall = provider.calls.map((c) => inputOf(c.user)).find((i) => i.rejected);
    expect(repairCall?.rejected).toEqual(['10']);
    expect((await texts(owner, l.id)).en?.description).not.toContain('10 minutes');

    const other = await create(owner, { bedrooms: 6 });
    mode = 'always-invents';
    const dropped = await aiFeatures.generateListingStudio(await single(owner, other.id, { locales: ['en', 'es'] }));
    expect(dropped.written).toEqual({});
    expect(dropped.dropped).toEqual({ [`${other.id}:en`]: 'FACTS', [`${other.id}:es`]: 'FACTS' });
    expect((await content(owner, other.id)).translations).toEqual([]);
  });

  it('[S12-02] locked locale untouched by bulk regeneration (also when locked while the batch runs)', async () => {
    useGateway();
    const a = await create(owner, { bedrooms: 4 });
    const b = await create(owner, { bedrooms: 2 });
    let v = (await translate(owner, a.id, 'es', { version: a.version, title: 'Villa de Ana', locked: true })).version;
    await translate(owner, a.id, 'en', { version: v, title: 'Ana villa' });

    const req = await bulk(owner, [a.id, b.id], { replaceReviewed: true });
    expect(req).toMatchObject({ mode: 'BULK', listingIds: [a.id, b.id] });
    const submitted = await aiFeatures.submitListingStudioBulk(req);
    if (submitted.status !== 'SUBMITTED') throw new Error('expected a provider batch');
    const batch = provider.batches.get(submitted.batchId);
    // a's locked es is not even asked for
    expect(batch?.items.map((i) => i.customId).sort()).toEqual(['l0_de', 'l0_en', 'l1_de', 'l1_en', 'l1_es']);

    // b's de gets a person's locked text while the batch runs
    v = (await content(owner, b.id)).version;
    await translate(owner, b.id, 'de', { version: v, title: 'Villa von Ana', locked: true });
    expect(await aiFeatures.collectListingStudioBulk(req)).toEqual({ status: 'IN_PROGRESS' });
    provider.endBatch(submitted.batchId);
    const done = await aiFeatures.collectListingStudioBulk(req);
    if (done.status !== 'DONE') throw new Error('expected the batch applied');
    expect(done.outcome.written[a.id]?.sort()).toEqual(['de', 'en']);
    expect(done.outcome.written[b.id]?.sort()).toEqual(['en', 'es']);

    const ta = await texts(owner, a.id);
    expect(ta.es).toMatchObject({ title: 'Villa de Ana', origin: 'HUMAN', locked: true });
    expect(ta.en).toMatchObject({ origin: 'AI_DRAFT' });
    expect(ta.en?.description).toContain('4 bedrooms');
    const tb = await texts(owner, b.id);
    expect(tb.de).toMatchObject({ title: 'Villa von Ana', origin: 'HUMAN', locked: true });
    expect(tb.es?.description).toContain('2 bedrooms');
    // the record is finished: a re-run of the collect job applies nothing twice
    const [record] = await rows<{ state: string; written: number }>(
      sql`select state, written from listing_studio_batches where id = ${req.requestId}`,
    );
    expect(record).toEqual({ state: 'DONE', written: 4 });
    expect(await aiFeatures.collectListingStudioBulk(req)).toEqual({
      status: 'DONE',
      outcome: { written: {}, dropped: {} },
    });
  });

  it('[S12-02] without replaceReviewed, texts a person wrote or reviewed stay; earlier AI drafts are replaced', async () => {
    useGateway();
    const l = await create(owner);
    await aiFeatures.generateListingStudio(await single(owner, l.id, { locales: ['en', 'es'] }));
    const v = (await content(owner, l.id)).version;
    await translate(owner, l.id, 'es', { version: v, title: 'Mi villa', description: 'Texto propio.' });

    const again = await aiFeatures.generateListingStudio(await single(owner, l.id, { tone: 'LUXURY' }));
    expect(again.written[l.id]?.sort()).toEqual(['de', 'en']);
    const t = await texts(owner, l.id);
    expect(t.es).toMatchObject({ title: 'Mi villa', origin: 'REVIEWED' });
    expect(t.en?.description).toContain('[en/LUXURY]');
    // the person's Spanish text is the source of the other locales
    const last = provider.calls.map((c) => inputOf(c.user)).filter((i) => i.tone === 'LUXURY');
    expect(last.every((i) => i.source?.locale === 'es' && (i.source.description ?? '').includes('Texto propio.'))).toBe(
      true,
    );
  });

  it('[S12-02] AI_DRAFT → REVIEWED: saving a draft, even unchanged, marks it reviewed', async () => {
    useGateway();
    const l = await create(owner);
    await aiFeatures.generateListingStudio(await single(owner, l.id, { locales: ['en'] }));
    const c = await content(owner, l.id);
    const draft = c.translations.find((t) => t.locale === 'en');
    expect(draft?.origin).toBe('AI_DRAFT');
    const saved = await translate(owner, l.id, 'en', {
      version: c.version,
      title: draft?.title,
      description: draft?.description,
      metaTitle: draft?.metaTitle,
      metaDescription: draft?.metaDescription,
    });
    expect(saved.translations.find((t) => t.locale === 'en')).toMatchObject({
      origin: 'REVIEWED',
      title: draft?.title,
    });
  });

  it('[S12-02] a draft generated from facts that changed meanwhile is not stored', async () => {
    useGateway();
    const l = await create(owner);
    const req = await bulk(owner, [l.id], { locales: ['en'] });
    const submitted = await aiFeatures.submitListingStudioBulk(req);
    if (submitted.status !== 'SUBMITTED') throw new Error('expected a provider batch');
    await as(owner, (ctx) =>
      properties.updateListing(ctx, l.id, UpdateListingBody.parse({ version: l.version, bedrooms: 5 })),
    );
    provider.endBatch(submitted.batchId);
    const done = await aiFeatures.collectListingStudioBulk(req);
    expect(done).toMatchObject({ status: 'DONE', outcome: { written: {}, dropped: { [`${l.id}:en`]: 'STALE' } } });
    expect((await content(owner, l.id)).translations).toEqual([]);
  });

  it('[S12-02] who may ask: agents only for their own listings; locales must be enabled; Client Mode refused', async () => {
    const mine = await create(agent);
    const theirs = await create(owner);
    expect(await refusal(single(agent, theirs.id))).toBe('FORBIDDEN');
    expect(await refusal(single(agent, newId()))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(single(agent, mine.id, { locales: ['fr'] }))).toBe('VALIDATION_FAILED:locales');
    expect((await single(agent, mine.id, { locales: ['es'] })).locales).toEqual(['es']);
    const dto = await as(agent, (ctx) =>
      aiFeatures.requestListingStudioBulk(ctx, ListingStudioBulkBody.parse({ listingIds: [theirs.id, mine.id] })),
    );
    expect(dto).toMatchObject({ listings: 1, skipped: 1 });
    expect(await refusal(as(agent, (ctx) => bulkOf(ctx, [theirs.id])))).toBe('FORBIDDEN');
    expect(
      await refusal(
        withMemberCtx({ ...agent, requestId: newId(), clientMode: true }, (ctx) =>
          aiFeatures.requestListingStudio(ctx, mine.id, ListingStudioBody.parse({})),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('[S12-02] provider outage: the job fails to be retried and writes nothing; core flows unaffected', async () => {
    useGateway();
    provider.failWith();
    const l = await create(owner);
    expect(await refusal(aiFeatures.generateListingStudio(await single(owner, l.id)))).toBe('AI_UNAVAILABLE');
    expect((await content(owner, l.id)).translations).toEqual([]);
  });

  it('[S12-02] a copy quoting the price or a large source figure is never stored', async () => {
    useGateway();
    const l = await create(owner, { priceCents: 450_000_00, bedrooms: 7 });
    // the agency's own Spanish text names the price: it may be translated, the figure may not
    await translate(owner, l.id, 'es', {
      version: l.version,
      title: 'Villa',
      description: 'Precio 450.000. Muy luminosa.',
    });
    mode = 'quotes-price';
    const out = await aiFeatures.generateListingStudio(await single(owner, l.id, { locales: ['en'] }));
    expect(out.written).toEqual({});
    expect(out.dropped).toEqual({ [`${l.id}:en`]: 'FACTS' });
    // the price itself never reached the model
    expect(provider.calls.map((c) => c.user).join(' ')).not.toMatch(/450000|45000000/);
    expect((await texts(owner, l.id)).en).toBeUndefined();
  });

  it('[S12-02] a replayed job writes nothing: no version bump, no event for the same drafts', async () => {
    useGateway();
    const l = await create(owner, { bedrooms: 8 });
    const req = await single(owner, l.id, { locales: ['en', 'es'] });
    expect((await aiFeatures.generateListingStudio(req)).written[l.id]?.sort()).toEqual(['en', 'es']);
    const before = await content(owner, l.id);
    const again = await aiFeatures.generateListingStudio(req);
    expect(again.written).toEqual({});
    expect((await content(owner, l.id)).version).toBe(before.version);
    const events = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events
          where type = 'properties.listing.updated' and payload->>'listingId' = ${l.id}`,
    );
    expect(events[0]?.n).toBe(1);
  });

  it('[S12-02] an agency has at most LISTING_STUDIO_RUNNING_MAX bulk batches running', async () => {
    const other = await createFounder();
    await setAgencyStatus(other.agencyId, 'VERIFIED');
    const l = await create(other);
    for (let i = 0; i < LISTING_STUDIO_RUNNING_MAX; i++) {
      await rows(sql`insert into listing_studio_batches
        (id, agency_id, created_by_user_id, listing_ids, locales, tone, facts_hashes, items)
        values (${newId()}, ${other.agencyId}, ${other.userId}, ${`{${l.id}}`}::uuid[], '{es}', 'WARM', '{x}', '[]')`);
    }
    expect(await refusal(bulk(other, [l.id]))).toBe('LISTING_STUDIO_BATCH_LIMIT');
    await rows(sql`update listing_studio_batches set state = 'DONE' where agency_id = ${other.agencyId}`);
    expect((await bulk(other, [l.id])).mode).toBe('BULK');
  });

  it('[S12-02] concurrent bulk requests cannot pass the running-batch cap together (reserved, serialized)', async () => {
    const other = await createFounder();
    await setAgencyStatus(other.agencyId, 'VERIFIED');
    const l = await create(other);
    const tries = 6;
    const results = await Promise.all(
      Array.from({ length: tries }, () =>
        refusal(
          as(other, (ctx) =>
            aiFeatures.requestListingStudioBulk(ctx, ListingStudioBulkBody.parse({ listingIds: [l.id] })),
          ),
        ),
      ),
    );
    expect(results.filter((r) => r === 'resolved')).toHaveLength(LISTING_STUDIO_RUNNING_MAX);
    expect(results.filter((r) => r === 'LISTING_STUDIO_BATCH_LIMIT')).toHaveLength(tries - LISTING_STUDIO_RUNNING_MAX);
    // the pending requests hold their reservations: one more is refused before any job ran
    const [held] = await rows<{ n: number }>(
      sql`select count(*)::int as n from listing_studio_batches where agency_id = ${other.agencyId} and state = 'RUNNING'`,
    );
    expect(held?.n).toBe(LISTING_STUDIO_RUNNING_MAX);
    expect(await refusal(bulk(other, [l.id]))).toBe('LISTING_STUDIO_BATCH_LIMIT');
  });

  it('[S12-02] a reserved batch with nothing to write is finished at submit, freeing its slot', async () => {
    useGateway();
    const other = await createFounder();
    await setAgencyStatus(other.agencyId, 'VERIFIED');
    await rows(sql`update agency_settings set enabled_locales = '{en}' where agency_id = ${other.agencyId}`);
    const l = await create(other);
    const v = (await content(other, l.id)).version;
    await translate(other, l.id, 'en', { version: v, title: 'My villa', locked: true });
    const req = await bulk(other, [l.id]);
    expect(await aiFeatures.submitListingStudioBulk(req)).toMatchObject({ status: 'DONE' });
    const [record] = await rows<{ state: string }>(
      sql`select state from listing_studio_batches where id = ${req.requestId}`,
    );
    expect(record?.state).toBe('DONE');
    expect(provider.batches.size).toBe(0);
  });

  it('[S12-02] a batch whose member lost access is marked GAVE_UP from a system transaction', async () => {
    useGateway();
    const helperId = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
        values (${helperId}, ${`helper-${helperId}@example.com`}, 'x', 'Helper', 'es', 'ACTIVE')`);
      await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
        values (${owner.agencyId}, ${helperId}, 'AGENCY_ADMIN', 'Helper', ${`helper-${helperId}@example.com`})`);
    });
    const helper = { userId: helperId, agencyId: owner.agencyId };
    const l = await create(owner, { bedrooms: 9 }); // an admin may run the studio on it
    const req = await bulk(helper, [l.id], { locales: ['en'] });
    const submitted = await aiFeatures.submitListingStudioBulk(req);
    expect(submitted.status).toBe('SUBMITTED');
    await rows(sql`delete from agency_members where agency_id = ${owner.agencyId} and user_id = ${helperId}`);
    const job = aiFeatures.aiFeaturesJobs.collectListingStudioBatch;
    await expect(
      job.spec.run(
        { requestId: req.requestId, agencyId: req.agencyId, userId: helperId, poll: 1 },
        { log, jobId: 'test', attempt: 1, progress: async () => {}, signal: new AbortController().signal },
      ),
    ).rejects.toThrow('FORBIDDEN');
    const [record] = await rows<{ state: string }>(
      sql`select state from listing_studio_batches where id = ${req.requestId}`,
    );
    expect(record?.state).toBe('GAVE_UP');
  });
});

const bulkOf = (ctx: Ctx, listingIds: string[]) =>
  aiFeatures.requestListingStudioBulk(ctx, ListingStudioBulkBody.parse({ listingIds }));
