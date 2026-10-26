import { fileURLToPath } from 'node:url';
import { CreateListingBody, type CreateSiteInput, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, withPublicRead, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureAi, createAiGateway, filePromptSource } from '@inmolink/platform/ai';
import { FakeProvider, memoryAiCache, memoryAiStore } from '@inmolink/platform/ai/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers, PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, setAiFeatures } from '../../../testing/factories';
import { whiteLabelLeaks } from '../../../testing/white-label';
import { blocksOf } from '../../../testing/white-label-fixtures';
import { readAiRemovalEntries, writeAiRemovals } from '../../../white-label-store';
import * as agencies from '../../agencies';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../../website-api';
import * as websites from '../../websites';
import {
  BACKFILL_PAGE_TARGETS,
  type BackfillCursor,
  type BackfillPageResult,
  collectWhiteLabelBackfill,
  DEGRADED_RETRY_DELAYS_MS,
  OWNER_CHANGE_WINDOW_MS,
  registerWhiteLabelSubscriptions,
  sanitizeTargetTexts,
  unregisterWhiteLabelSubscriptions,
  WHITE_LABEL_POLL_MS,
  WHITE_LABEL_SWEEP_EVERY_MS,
  whiteLabelBackfillPage,
  whiteLabelJobs,
} from '../index';

/**
 * White-label sanitizer's model pass end to end (S12-03): a network listing's description with direct and indirect
 * owner mentions, the worker's pass (`sanitizeTargetTexts`, the gateway on a fake provider) caching its removals on
 * redis-cache, and the website API serving the cleaned text from that cache — deterministic-only before the pass,
 * after an edit and with the model down, never calling the model per request.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-wl-${RUN}`;
const OWNER_NAME = `Ownerhaus Sanitize ${RUN}`;
const OWNER_MAIL = `sales-${RUN.toLowerCase()}@ownerhaus-sanitize.example`;
const INDIRECT = 'For a viewing ask for Marisol at our Nerja office.';
const FACTS = ['4 bedrooms', '320 m²', 'built in 2011'];
const DESCRIPTION = `Villa with ${FACTS[0]} and ${FACTS[1]}, ${FACTS[2]}. ${INDIRECT} Call ${OWNER_NAME} on +34 952 761 234 or mail ${OWNER_MAIL}.`;
const PROMPTS_DIR = fileURLToPath(new URL('../../../../prompts', import.meta.url));
const log = createLogger({ service: 'white-label-int', level: 'silent' });

let a: Founder;
let b: Founder;
let listingId = '';
let siteId = '';
let taxonomyIds = { city: '', villa: '' };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

function gateway(provider: FakeProvider) {
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
  return provider;
}

/** Names the indirect sentence wherever it is sent. */
const model = () =>
  new FakeProvider((request) => {
    const texts = blocksOf(request.user);
    return JSON.stringify({ remove: texts.some((t) => t.includes(INDIRECT)) ? [INDIRECT] : [] });
  });

const SITE: CreateSiteInput = {
  name: 'Costa Sanitize',
  domains: ['www.costa-sanitize.example'],
  mode: 'IFRAME',
  inventoryPolicy: 'CUSTOM',
  inventoryFilters: null,
  referencePrefix: 'CS',
  locales: ['en'],
  contact: { name: 'Costa Sanitize Homes', email: 'hello@costa-sanitize.example', phone: '+34 600 000 019' },
};

async function served(): Promise<{ description: string | null; statements: number; detail: unknown }> {
  const ref = `CS-${(await withPublicRead((tx) => search.publicCodes(tx, [listingId]))).get(listingId)}`;
  let detail: Awaited<ReturnType<typeof websiteApi.embedDetail>> | undefined;
  const statements = await countQueries(async () => {
    detail = await websiteApi.embedDetail(await websiteApi.embedSite(siteId, newId()), ref, 'en');
  });
  return { description: (detail as { description?: string | null }).description ?? null, statements, detail };
}

async function setDescription(description: string): Promise<void> {
  await as(b, async (ctx) =>
    properties.saveListingTranslation(ctx, listingId, 'en', {
      version: (await properties.getListing(ctx, listingId)).version,
      title: `Villa ${RUN}`,
      description,
    }),
  );
  await withSystem('wl.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [listingId]));
}

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:wl:${RUN}`, commandTimeoutMs: 2_000 });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
    embedOrigin: 'https://sites.inmolink.test',
  });
  search.configureNetworkSearch({ giveToGetMinShared: 1, giveToGetGraceDays: 0 });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  a = await createFounder();
  b = await createFounder({ companyName: OWNER_NAME });
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  // S13-F17: the model pass runs only for agencies that switched it on (every AI feature is off by default).
  for (const m of [a, b]) await setAiFeatures(m, ['WHITE_LABEL']);
  const ids = await withSystem('wl.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Sanitland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: name('Port'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('v'),
      sort: 0,
      translations: name('Villa'),
    });
    return { country, city, villa };
  });
  taxonomyIds = { city: ids.city, villa: ids.villa };
  // a's own listing: give-to-get lets a's site show the network.
  for (const [m, description] of [
    [a, 'Sunny villa with a pool.'],
    [b, DESCRIPTION],
  ] as const) {
    const { id } = await as(m, (ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 45_000_000,
          energyRating: 'B',
        }),
      ),
    );
    await as(m, async (ctx) =>
      properties.saveListingTranslation(ctx, id, 'en', {
        version: (await properties.getListing(ctx, id)).version,
        title: `Villa ${RUN}`,
        description,
      }),
    );
    await as(m, async (ctx) =>
      properties.updateListing(
        ctx,
        id,
        UpdateListingBody.parse({
          status: 'ACTIVE',
          visibility: 'PUBLIC',
          shareScope: 'ALL',
          version: (await properties.getListing(ctx, id)).version,
        }),
      ),
    );
    await withSystem('wl.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
    if (m === b) listingId = id;
  }
  const filters = {
    includeOwn: true,
    includeNetwork: true,
    locationIds: [ids.country],
    propertyTypeIds: [],
    newBuilds: true,
  };
  siteId = (await as(a, (ctx) => websites.createSite(ctx, { ...SITE, inventoryFilters: filters }))).id;
}, 180_000);

afterAll(async () => {
  configureAi(undefined);
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

describe('white-label sanitizer model pass (S12-03)', () => {
  it('[S12-03] the job runs in the ai worker pool, one run per agency at a time', () => {
    expect(whiteLabelJobs.sanitizeTexts.pool).toBe('ai');
    expect(whiteLabelJobs.sanitizeTexts.spec.concurrencyPerGroup).toBe(1);
  });

  it('[S12-03] before the pass: deterministic only (direct contacts gone, facts kept), no model call', async () => {
    const provider = gateway(model());
    const before = await served();
    expect(before.description).toContain(INDIRECT);
    for (const f of FACTS) expect(before.description).toContain(f);
    expect(
      whiteLabelLeaks(before.detail, {
        name: OWNER_NAME,
        email: OWNER_MAIL,
        domain: 'ownerhaus-sanitize.example',
        ref: (await as(b, (ctx) => properties.getListing(ctx, listingId))).ref as string,
        phone: '+34 952 761 234',
        phoneDigits: '952761234',
      }),
    ).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it('[S12-03] after the worker pass: the website serves the cached cleaned text — zero leaks, facts unchanged, ≤ 3 statements, no model call per request', async () => {
    const provider = gateway(model());
    const result = await sanitizeTargetTexts({ agencyId: b.agencyId, targetIds: [listingId] });
    expect(result).toMatchObject({ docs: 1, asked: 1, stored: 1, degraded: 0 });
    // Only deterministically cleaned text reached the provider.
    expect(provider.calls[0]?.user).not.toContain(OWNER_MAIL);
    expect(provider.calls[0]?.user).not.toContain('761 234');
    const entries = await readAiRemovalEntries([{ agencyId: b.agencyId, targetId: listingId }]);
    expect(entries.get(listingId)?.prompt).toBe(1);

    const calls = provider.calls.length;
    const after = await served();
    expect(after.description).not.toContain('Marisol');
    for (const f of FACTS) expect(after.description).toContain(f);
    expect(after.statements).toBeLessThanOrEqual(3);
    expect(provider.calls.length).toBe(calls);

    // Idempotent: a repeated event finds the document answered.
    expect(await sanitizeTargetTexts({ agencyId: b.agencyId, targetIds: [listingId] })).toMatchObject({ asked: 0 });
    // Another agency's documents are never processed under this agency's run.
    expect(await sanitizeTargetTexts({ agencyId: a.agencyId, targetIds: [listingId] })).toMatchObject({ docs: 0 });
  });

  it('[S12-03] a new listing version is deterministic-only until its pass; model down: stays deterministic, nothing breaks', async () => {
    const edited = `${DESCRIPTION} New kitchen.`;
    await setDescription(edited);
    const stale = await served();
    expect(stale.description).toContain(INDIRECT);
    expect(stale.description).toContain('New kitchen');

    gateway(new FakeProvider().failWith());
    expect(await sanitizeTargetTexts({ agencyId: b.agencyId, targetIds: [listingId] })).toMatchObject({
      asked: 1,
      degraded: 1,
      stored: 0,
    });
    expect((await served()).description).toContain(INDIRECT);

    gateway(model());
    expect(await sanitizeTargetTexts({ agencyId: b.agencyId, targetIds: [listingId] })).toMatchObject({ stored: 1 });
    const fresh = await served();
    expect(fresh.description).not.toContain('Marisol');
    expect(fresh.description).toContain('New kitchen');
  });
});

/**
 * S13-F25: the agency's whole backfill walk — each page submitted (its batch recorded), then every submitted batch
 * ended by the fake provider and collected. Answers the pages (with what their collect stored).
 */
async function walkAndCollect(
  provider: FakeProvider,
  agencyId: string,
  options: { force?: boolean } = {},
): Promise<BackfillPageResult[]> {
  const run = newId();
  const pages: BackfillPageResult[] = [];
  const submitted: { pageKey: string; page: BackfillPageResult }[] = [];
  let after: BackfillCursor | null = null;
  do {
    const pageKey = `wlb.t-${run}.${pages.length}`;
    const page: BackfillPageResult = await whiteLabelBackfillPage({ agencyId, after, pageKey, force: options.force });
    pages.push(page);
    if (page.batch === 'SUBMITTED') submitted.push({ pageKey, page });
    after = page.next;
  } while (after);
  for (const [batchId, batch] of provider.batches) if (!batch.ended) provider.endBatch(batchId);
  for (const { pageKey, page } of submitted) {
    const res = await collectWhiteLabelBackfill({ agencyId, pageKey });
    if (res.status !== 'DONE') throw new Error(`batch ${pageKey} still running`);
    page.stored += res.stored;
  }
  return pages;
}

/** Runs one subscriber of an event as the dispatcher would. */
async function deliver(
  type: string,
  subscriber: string,
  payload: unknown,
  meta: { eventId: string; agencyId: string },
) {
  for (const sub of defaultSubscribers.get(type, 1)) {
    if (sub.name !== subscriber) continue;
    await sub.handler(payload as never, { ...meta, type, version: 1, createdAt: new Date(), attempt: 1 });
  }
}

/** `search.publicDocs.changed` events of an agency written after `since` (a UUIDv7 taken before the change). */
async function publicDocsEvents(agencyId: string, since: string) {
  const res = await withSystem('wl.test', (tx) =>
    tx.execute<{ payload: { targetIds: string[]; networkShownIds?: string[] } }>(
      sql`select payload from outbox_events
           where agency_id = ${agencyId} and type = 'search.publicDocs.changed' and id > ${since}::uuid
           order by id`,
    ),
  );
  return res.rows.map((r) => r.payload);
}

/** Runs the model pass's subscriber over these events as the dispatcher would; answers the jobs it queued. */
async function sanitizeJobsOf(agencyId: string, events: readonly unknown[]): Promise<{ targetIds: string[] }[]> {
  const spy = vi.spyOn(whiteLabelJobs.sanitizeTexts, 'enqueue').mockResolvedValue(undefined as never);
  try {
    for (const payload of events) {
      for (const sub of defaultSubscribers.get('search.publicDocs.changed', 1)) {
        if (sub.name !== 'aiFeatures.whiteLabel.publicDocsChanged') continue;
        await sub.handler(payload as never, {
          eventId: newId(),
          agencyId,
          type: 'search.publicDocs.changed',
          version: 1,
          createdAt: new Date(),
          attempt: 1,
        });
      }
    }
    return spy.mock.calls.map((c) => c[0] as { targetIds: string[] });
  } finally {
    spy.mockRestore();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A change of the owner's listing, its rebuild, and the sanitize jobs its events queue. */
async function jobsAfter(change: () => Promise<unknown>) {
  const since = newId();
  await tick();
  await change();
  await withSystem('wl.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [listingId]));
  const events = await publicDocsEvents(b.agencyId, since);
  return { events, jobs: await sanitizeJobsOf(b.agencyId, events) };
}

const updateB = (fields: Record<string, unknown>) =>
  as(b, async (ctx) =>
    properties.updateListing(
      ctx,
      listingId,
      UpdateListingBody.parse({ ...fields, version: (await properties.getListing(ctx, listingId)).version }),
    ),
  );

const ownerOfB = async () => ({
  name: OWNER_NAME,
  email: OWNER_MAIL,
  domain: 'ownerhaus-sanitize.example',
  ref: (await as(b, (ctx) => properties.getListing(ctx, listingId))).ref as string,
  phone: '+34 952 761 234',
  phoneDigits: '952761234',
});

describe('white-label pass only for network-shown documents; backfill (S13-F7)', () => {
  beforeAll(() => registerWhiteLabelSubscriptions());
  afterAll(() => unregisterWhiteLabelSubscriptions());

  it('[S13-F7] a price-only edit and a private/own-only change queue zero sanitizeTexts jobs', async () => {
    // Price only: the documents are rewritten (the event still goes out for the edge purge), the text is not.
    const price = await jobsAfter(() => updateB({ priceCents: 46_000_000 }));
    expect(price.events.length).toBeGreaterThan(0);
    expect(price.events.flatMap((e) => e.networkShownIds ?? ['absent'])).toEqual([]);
    expect(price.jobs).toEqual([]);

    // Control: a text edit of a network-shown listing queues exactly its pass.
    const text = await jobsAfter(() => setDescription(`${DESCRIPTION} Sea views.`));
    expect(text.jobs).toEqual([expect.objectContaining({ targetIds: [listingId] })]);

    // Own-only: public, shared with PREFERRED agencies but none chosen (only the owner's own site shows it).
    const ownOnly = await jobsAfter(async () => {
      await updateB({ shareScope: 'PREFERRED' });
      await setDescription(`${DESCRIPTION} Own site only.`);
    });
    expect(ownOnly.events.length).toBeGreaterThan(0);
    expect(ownOnly.jobs).toEqual([]);
    expect(
      await withSystem('wl.test', (tx) => search.networkShownTargetsPage(tx, b.agencyId, null, 100)),
    ).not.toContainEqual(expect.objectContaining({ targetId: listingId }));
    // Shared with every agency again: new to the network, so its pass runs (no text edit needed).
    const shared = await jobsAfter(() => updateB({ shareScope: 'ALL' }));
    expect(shared.jobs).toEqual([expect.objectContaining({ targetIds: [listingId] })]);

    // Private, with a text edit on the way: nobody on the network sees it.
    const priv = await jobsAfter(async () => {
      await updateB({ visibility: 'PRIVATE' });
      await setDescription(`${DESCRIPTION} Private now.`);
    });
    expect(priv.events.length).toBeGreaterThan(0);
    expect(priv.jobs).toEqual([]);
    const back = await jobsAfter(() => updateB({ visibility: 'PUBLIC', shareScope: 'ALL' }));
    expect(back.jobs).toEqual([expect.objectContaining({ targetIds: [listingId] })]);

    // An event from before the field (no `networkShownIds`) still names every target.
    expect(
      await sanitizeJobsOf(b.agencyId, [{ agencyId: b.agencyId, targetIds: [listingId], developmentIds: [] }]),
    ).toEqual([expect.objectContaining({ targetIds: [listingId] })]);
  });

  it('[S13-F7] visibility changes with unchanged text put the target in networkShownIds', async () => {
    const shownIn = (events: { targetIds: string[]; networkShownIds?: string[] }[]) =>
      events.flatMap((e) => e.networkShownIds ?? e.targetIds);

    // PRIVATE → PUBLIC.
    expect(shownIn((await jobsAfter(() => updateB({ visibility: 'PRIVATE' }))).events)).toEqual([]);
    expect(shownIn((await jobsAfter(() => updateB({ visibility: 'PUBLIC' }))).events)).toEqual([listingId]);

    // PREFERRED with an empty list → one preferred agency.
    expect(shownIn((await jobsAfter(() => updateB({ shareScope: 'PREFERRED' }))).events)).toEqual([]);
    const preferred = await jobsAfter(() => as(b, (ctx) => agencies.addPreferredAgency(ctx, { agencyId: a.agencyId })));
    expect(shownIn(preferred.events)).toEqual([listingId]);
    expect(preferred.jobs).toEqual([expect.objectContaining({ targetIds: [listingId] })]);
    await as(b, (ctx) => agencies.removePreferredAgency(ctx, { agencyId: a.agencyId }));
    await jobsAfter(() => updateB({ shareScope: 'ALL' }));

    // WITHDRAWN → a shown status.
    expect(shownIn((await jobsAfter(() => updateB({ status: 'WITHDRAWN' }))).events)).toEqual([]);
    expect(shownIn((await jobsAfter(() => updateB({ status: 'ACTIVE' }))).events)).toEqual([listingId]);
  });

  it('[S13-F7] a degraded run asks again later for its degraded targets, a bounded number of times', async () => {
    gateway(new FakeProvider().failWith());
    await writeAiRemovals({ agencyId: b.agencyId, targetId: listingId }, null);
    const spy = vi.spyOn(whiteLabelJobs.sanitizeTexts, 'enqueue').mockResolvedValue(undefined as never);
    const ctx = { log, jobId: 'wl-retry', attempt: 1, progress: async () => {}, signal: new AbortController().signal };
    const payload = { eventId: newId(), agencyId: b.agencyId, targetIds: [listingId], retry: 0 };
    try {
      await whiteLabelJobs.sanitizeTexts.spec.run(payload, ctx);
      expect(spy.mock.calls).toEqual([[{ ...payload, retry: 1 }, { delayMs: DEGRADED_RETRY_DELAYS_MS[0] }]]);
      expect(whiteLabelJobs.sanitizeTexts.spec.jobId?.({ ...payload, retry: 1 })).toBe(`${payload.eventId}.r1`);
      // The last retry gives up (the backfill sweep covers the target).
      spy.mockClear();
      await whiteLabelJobs.sanitizeTexts.spec.run({ ...payload, retry: DEGRADED_RETRY_DELAYS_MS.length }, ctx);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('[S13-F7] existing network docs get removals via the backfill (model only where needed, leak-free after)', async () => {
    expect(whiteLabelJobs.whiteLabelBackfill.pool).toBe('ai');
    expect(whiteLabelJobs.whiteLabelBackfill.spec.concurrencyPerGroup).toBe(1);
    expect(
      whiteLabelJobs.whiteLabelBackfill.spec.group?.({
        run: '2026-10-25',
        agencyId: b.agencyId,
        after: null,
        force: false,
      }),
    ).toBe(`wl:${b.agencyId}`);
    expect(whiteLabelJobs.whiteLabelSweep.pool).toBe('maintenance');
    expect(whiteLabelJobs.whiteLabelSweep.spec.every).toBe(WHITE_LABEL_SWEEP_EVERY_MS);

    // A document shown before the model pass existed: no entry, deterministic only.
    await writeAiRemovals({ agencyId: b.agencyId, targetId: listingId }, null);
    const before = await served();
    expect(before.description).toContain(INDIRECT);
    expect(whiteLabelLeaks(before.detail, await ownerOfB())).toEqual([]);

    const provider = gateway(model());
    const walk = () => walkAndCollect(provider, b.agencyId);
    const first = await walk();
    expect(first.reduce((n, p) => n + p.stored, 0)).toBe(1);
    expect(provider.calls).toHaveLength(1);
    const after = await served();
    expect(after.description).not.toContain('Marisol');
    for (const f of FACTS) expect(after.description).toContain(f);
    expect(whiteLabelLeaks(after.detail, await ownerOfB())).toEqual([]);

    // Idempotent: a second walk finds the entry answering the text (kept alive) — no model call.
    const second = await walk();
    expect(second.reduce((n, p) => n + p.asked, 0)).toBe(0);
    expect(provider.calls).toHaveLength(1);
    expect((await readAiRemovalEntries([{ agencyId: b.agencyId, targetId: listingId }])).has(listingId)).toBe(true);

    // A private document is never walked.
    await updateB({ visibility: 'PRIVATE' });
    await withSystem('wl.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [listingId]));
    expect((await walk()).reduce((n, p) => n + p.targets, 0)).toBe(0);
    await updateB({ visibility: 'PUBLIC', shareScope: 'ALL' });
    await withSystem('wl.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [listingId]));
  });

  it('[S13-F7] perf: ~0 sanitize jobs per 1k unchanged targets on a rebuild', async () => {
    const N = 250;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const { id } = await as(a, (ctx) =>
        properties.createListing(
          ctx,
          CreateListingBody.parse({
            propertyTypeId: taxonomyIds.villa,
            locationId: taxonomyIds.city,
            priceCents: 30_000_000 + i,
            energyRating: 'B',
          }),
        ),
      );
      await as(a, async (ctx) =>
        properties.updateListing(
          ctx,
          id,
          UpdateListingBody.parse({
            status: 'ACTIVE',
            visibility: 'PUBLIC',
            shareScope: 'ALL',
            version: (await properties.getListing(ctx, id)).version,
          }),
        ),
      );
      ids.push(id);
    }
    const rebuild = async () => {
      for (let i = 0; i < ids.length; i += search.READ_MODEL_BATCH) {
        await withSystem('wl.test', (tx) =>
          search.rebuildReadModels(tx, 'LISTING', ids.slice(i, i + search.READ_MODEL_BATCH)),
        );
      }
    };
    // First build: every target is new to the network (control).
    let since = newId();
    await tick();
    await rebuild();
    const built = await publicDocsEvents(a.agencyId, since);
    expect(new Set(built.flatMap((e) => e.networkShownIds ?? e.targetIds)).size).toBe(N);

    // The backfill's walk pages the agency (> 50 targets) by a row keyset: every target exactly once.
    const walked: string[] = [];
    let cursor: BackfillCursor | null = null;
    do {
      const after: BackfillCursor | null = cursor;
      const page: BackfillCursor[] = await withSystem('wl.test', (tx) =>
        search.networkShownTargetsPage(tx, a.agencyId, after, BACKFILL_PAGE_TARGETS),
      );
      walked.push(...page.map((p) => p.targetId));
      cursor = page.length === BACKFILL_PAGE_TARGETS ? (page.at(-1) ?? null) : null;
    } while (cursor);
    expect(walked).toHaveLength(new Set(walked).size);
    for (const id of ids) expect(walked).toContain(id);

    // A builder change re-writes every row with the same text (the stored etags no longer match).
    await withSystem('wl.test', (tx) =>
      tx.execute(
        sql`update listing_read_models set etag = 'stale' where target_id = any(${`{${ids.join(',')}}`}::uuid[])`,
      ),
    );
    since = newId();
    await tick();
    await rebuild();
    const events = await publicDocsEvents(a.agencyId, since);
    // The rows were re-written (events went out for the edge purge) …
    expect(new Set(events.flatMap((e) => e.targetIds)).size).toBe(N);
    // … but no target is new to the network: zero ids, zero jobs (0 per 1k).
    expect(events.flatMap((e) => e.networkShownIds ?? ['absent'])).toEqual([]);
    const jobs = await sanitizeJobsOf(a.agencyId, events);
    expect((jobs.length * 1_000) / N).toBe(0);
  }, 300_000);
});

describe('white-label model pass toggle (S13-F17)', () => {
  beforeAll(() => registerWhiteLabelSubscriptions());
  afterAll(async () => {
    unregisterWhiteLabelSubscriptions();
    await setAiFeatures(b, ['WHITE_LABEL']);
  });

  it('[S13-F17] white-label model pass off: events, retries and the backfill make zero provider calls and re-queue nothing', async () => {
    const provider = gateway(model());
    await writeAiRemovals({ agencyId: b.agencyId, targetId: listingId }, null);
    // every other AI feature on, the model pass off
    await setAiFeatures(b, ['WEBSITE_SEARCH', 'LISTING_STUDIO', 'SOCIAL_CAPTIONS', 'TRANSLATION_DRAFTS']);
    await setAiFeatures(b, ['WHITE_LABEL'], false);

    // An event naming a network-shown target queues no job.
    const event = { agencyId: b.agencyId, targetIds: [listingId], networkShownIds: [listingId], developmentIds: [] };
    expect(await sanitizeJobsOf(b.agencyId, [event])).toEqual([]);

    // A job (queued before the switch) and its retries: no model call, no retry queued.
    const spy = vi.spyOn(whiteLabelJobs.sanitizeTexts, 'enqueue').mockResolvedValue(undefined as never);
    const ctx = { log, jobId: 'wl-off', attempt: 1, progress: async () => {}, signal: new AbortController().signal };
    try {
      for (const retry of [0, 1]) {
        const res = await whiteLabelJobs.sanitizeTexts.spec.run(
          { eventId: newId(), agencyId: b.agencyId, targetIds: [listingId], retry },
          ctx,
        );
        expect(res).toMatchObject({ disabled: true, asked: 0, degraded: 0 });
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    // The backfill: the walk ends at once, the sweep does not page the agency.
    const page = await whiteLabelBackfillPage({ agencyId: b.agencyId, after: null, pageKey: `wl-off.${newId()}` });
    expect(page).toMatchObject({ disabled: true, next: null, asked: 0 });
    const swept = await withSystem('wl.test', (tx) =>
      agencies.agencyIdsWithAiFeaturePage(tx, 'WHITE_LABEL', null, 100_000),
    );
    expect(swept).not.toContain(b.agencyId);
    expect(swept).toContain(a.agencyId);
    expect(provider.calls).toHaveLength(0);
    // Served deterministic-only: no leak of a direct contact.
    expect(whiteLabelLeaks((await served()).detail, await ownerOfB())).toEqual([]);
  });

  it('[S13-F17] white-label model pass on: the event queues the job and the model is asked', async () => {
    const provider = gateway(model());
    await setAiFeatures(b, ['WHITE_LABEL']);
    const event = { agencyId: b.agencyId, targetIds: [listingId], networkShownIds: [listingId], developmentIds: [] };
    expect(await sanitizeJobsOf(b.agencyId, [event])).toEqual([expect.objectContaining({ targetIds: [listingId] })]);
    await writeAiRemovals({ agencyId: b.agencyId, targetId: listingId }, null);
    const res = await sanitizeTargetTexts({ agencyId: b.agencyId, targetIds: [listingId] });
    expect(res.disabled).toBeUndefined();
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(
      await withSystem('wl.test', (tx) => agencies.agencyIdsWithAiFeaturePage(tx, 'WHITE_LABEL', null, 100_000)),
    ).toContain(b.agencyId);
  });
});

describe('white-label backfill on the batch API; owner changes re-run it (S13-F25)', () => {
  beforeAll(async () => {
    registerWhiteLabelSubscriptions();
    await setAiFeatures(b, ['WHITE_LABEL']);
  });
  afterAll(() => unregisterWhiteLabelSubscriptions());

  const jobCtx = () => ({
    log,
    jobId: 'wl-f25',
    attempt: 1,
    progress: async () => {},
    signal: new AbortController().signal,
  });

  it('[S13-F25] a backfill page goes through ai.batch and its removals land after collect', async () => {
    await writeAiRemovals({ agencyId: b.agencyId, targetId: listingId }, null);
    const provider = gateway(model());
    const pageKey = `wlb.t-${newId()}.0`;
    const page = await whiteLabelBackfillPage({ agencyId: b.agencyId, after: null, pageKey });
    expect(page).toMatchObject({ batch: 'SUBMITTED', stored: 0, degraded: 0, next: null });
    expect(page.asked).toBeGreaterThan(0);
    // One provider batch, no interactive call; the items are kept in the table (the job carries ids only).
    expect(provider.batches.size).toBe(1);
    expect(provider.calls).toHaveLength(0);
    const [batchId] = [...provider.batches.keys()] as [string];
    const recorded = await batchRecord(pageKey);
    expect(recorded).toMatchObject({ state: 'RUNNING', provider_batch_id: batchId });
    expect(recorded?.items).toContainEqual(expect.objectContaining({ targetId: listingId }));
    // A retried submit sends nothing twice.
    expect(await whiteLabelBackfillPage({ agencyId: b.agencyId, after: null, pageKey })).toMatchObject({
      batch: 'SUBMITTED',
    });
    expect(provider.batches.size).toBe(1);

    // Until the batch ends: still deterministic only.
    expect(await collectWhiteLabelBackfill({ agencyId: b.agencyId, pageKey })).toEqual({ status: 'IN_PROGRESS' });
    expect((await served()).description).toContain(INDIRECT);

    provider.endBatch(batchId);
    expect(await collectWhiteLabelBackfill({ agencyId: b.agencyId, pageKey })).toMatchObject({
      status: 'DONE',
      stored: 1,
      degraded: 0,
    });
    const after = await served();
    expect(after.description).not.toContain('Marisol');
    for (const f of FACTS) expect(after.description).toContain(f);
    expect(whiteLabelLeaks(after.detail, await ownerOfB())).toEqual([]);
    expect((await batchRecord(pageKey))?.state).toBe('DONE');
    // A re-run collect applies nothing twice.
    expect(await collectWhiteLabelBackfill({ agencyId: b.agencyId, pageKey })).toMatchObject({
      status: 'DONE',
      stored: 0,
    });
  });

  it('[S13-F25] the backfill job queues the collect (ids only), which polls until the batch ends', async () => {
    await writeAiRemovals({ agencyId: b.agencyId, targetId: listingId }, null);
    const provider = gateway(model());
    const collect = vi.spyOn(whiteLabelJobs.collectWhiteLabelBatch, 'enqueue').mockResolvedValue(undefined as never);
    const nextPage = vi.spyOn(whiteLabelJobs.whiteLabelBackfill, 'enqueue').mockResolvedValue(undefined as never);
    try {
      const payload = { run: '2026-10-26', agencyId: b.agencyId, after: null, force: false };
      const pageKey = whiteLabelJobs.whiteLabelBackfill.spec.jobId?.(payload) as string;
      expect(pageKey).toBe(`wlb.2026-10-26.${b.agencyId}.start`);
      await batchCleared(pageKey);
      await whiteLabelJobs.whiteLabelBackfill.spec.run(payload, jobCtx());
      const first = { agencyId: b.agencyId, pageKey, poll: 1 };
      expect(collect.mock.calls).toEqual([[first, { delayMs: WHITE_LABEL_POLL_MS }]]);
      expect(JSON.stringify(first).length).toBeLessThan(10_000);
      expect(nextPage).not.toHaveBeenCalled(); // b's one target: a single page

      await whiteLabelJobs.collectWhiteLabelBatch.spec.run(first, jobCtx());
      expect(collect).toHaveBeenLastCalledWith({ ...first, poll: 2 }, { delayMs: WHITE_LABEL_POLL_MS });
      for (const id of provider.batches.keys()) provider.endBatch(id);
      const done = await whiteLabelJobs.collectWhiteLabelBatch.spec.run({ ...first, poll: 2 }, jobCtx());
      expect(done).toMatchObject({ status: 'DONE', stored: 1 });
      expect(collect).toHaveBeenCalledTimes(2);
      expect(whiteLabelLeaks((await served()).detail, await ownerOfB())).toEqual([]);
    } finally {
      collect.mockRestore();
      nextPage.mockRestore();
    }
  });

  it('[S13-F25] an owner-change walk asks answered targets again; unchanged texts are answered by the cache', async () => {
    await writeAiRemovals({ agencyId: b.agencyId, targetId: listingId }, null);
    const provider = gateway(model());
    expect((await walkAndCollect(provider, b.agencyId)).reduce((n, p) => n + p.stored, 0)).toBe(1);
    expect(provider.batches.size).toBe(1);
    // The sweep's walk: answered, nothing asked.
    expect((await walkAndCollect(provider, b.agencyId)).reduce((n, p) => n + p.asked, 0)).toBe(0);
    // An owner-change walk asks again — the same cleaned text comes from the response cache: no second batch.
    const forced = await walkAndCollect(provider, b.agencyId, { force: true });
    expect(forced.reduce((n, p) => n + p.asked, 0)).toBeGreaterThan(0);
    expect(forced.every((p) => p.batch === null)).toBe(true);
    expect(provider.batches.size).toBe(1);
    expect(whiteLabelLeaks((await served()).detail, await ownerOfB())).toEqual([]);
  });

  it("[S13-F25] renaming the agency or a new agent queues the agency's walk once — a burst of changes runs one walk", async () => {
    const spy = vi.spyOn(whiteLabelJobs.whiteLabelBackfill, 'enqueue').mockResolvedValue(undefined as never);
    const jobIdOf = (p: unknown) => whiteLabelJobs.whiteLabelBackfill.spec.jobId?.(p as never);
    const fake = useFakeClock('2026-10-26T10:03:00.000Z');
    try {
      const meta = () => ({ eventId: newId(), agencyId: b.agencyId });
      const platform = () => ({ eventId: newId(), agencyId: PLATFORM_AGENCY_ID });
      const joined = { memberAgencyId: b.agencyId, userId: b.userId, change: 'JOINED' };
      const details = (identityChanged: boolean) => ({
        agencyId: b.agencyId,
        version: 9,
        firstOnboarding: false,
        identityChanged,
      });
      const profile = (p: { logoChanged: boolean; identityChanged: boolean }) => ({
        agencyId: b.agencyId,
        version: 9,
        actorUserId: b.userId,
        impersonatedBy: null,
        ...p,
      });
      // A burst within one window: the agency renamed, its contacts edited, three agents joining (one event delivered
      // twice by an outbox retry) — minutes apart.
      const redelivered = platform();
      const burst: [string, string, unknown, { eventId: string; agencyId: string }][] = [
        ['agencies.details.updated', 'aiFeatures.whiteLabel.ownerDetailsChanged', details(true), meta()],
        [
          'agencies.profile.updated',
          'aiFeatures.whiteLabel.ownerProfileChanged',
          profile({ logoChanged: false, identityChanged: true }),
          meta(),
        ],
        ['identity.member.named', 'aiFeatures.whiteLabel.memberNamed', joined, redelivered],
        ['identity.member.named', 'aiFeatures.whiteLabel.memberNamed', joined, redelivered],
        ['identity.member.named', 'aiFeatures.whiteLabel.memberNamed', joined, platform()],
        ['identity.member.named', 'aiFeatures.whiteLabel.memberNamed', joined, platform()],
      ];
      for (const [type, subscriber, payload, m] of burst) {
        await deliver(type, subscriber, payload, m);
        fake.advance(60_000);
      }
      // Changes that clean nothing new: colours or the logo only, details without an identity field.
      await deliver(
        'agencies.profile.updated',
        'aiFeatures.whiteLabel.ownerProfileChanged',
        profile({ logoChanged: true, identityChanged: false }),
        meta(),
      );
      await deliver('agencies.details.updated', 'aiFeatures.whiteLabel.ownerDetailsChanged', details(false), meta());

      expect(spy).toHaveBeenCalledTimes(burst.length);
      // One walk: every change queued the same job (BullMQ keeps one job per id) …
      expect(new Set(spy.mock.calls.map((c) => jobIdOf(c[0])))).toEqual(
        new Set([`wlb.i-202610261000.${b.agencyId}.start`]),
      );
      expect(spy.mock.calls[0]?.[0]).toEqual({ run: 'i-202610261000', agencyId: b.agencyId, after: null, force: true });
      // … starting after the window closed (10:10 + a minute of slack), so it reads the identity after the last change.
      const firstDelay = (spy.mock.calls[0]?.[1] as { delayMs: number } | undefined)?.delayMs;
      expect(firstDelay).toBe(Date.parse('2026-10-26T10:11:00.000Z') - Date.parse('2026-10-26T10:03:00.000Z'));
      expect(OWNER_CHANGE_WINDOW_MS).toBe(10 * 60_000);

      // A change in the next window: a second walk.
      spy.mockClear();
      fake.set('2026-10-26T10:12:00.000Z');
      await deliver('identity.member.named', 'aiFeatures.whiteLabel.memberNamed', joined, platform());
      expect(spy.mock.calls.map((c) => jobIdOf(c[0]))).toEqual([`wlb.i-202610261010.${b.agencyId}.start`]);

      // The model pass off: nothing.
      spy.mockClear();
      await setAiFeatures(b, ['WHITE_LABEL'], false);
      await deliver('identity.member.named', 'aiFeatures.whiteLabel.memberNamed', joined, platform());
      await deliver('agencies.details.updated', 'aiFeatures.whiteLabel.ownerDetailsChanged', details(true), meta());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restoreClock();
      spy.mockRestore();
      await setAiFeatures(b, ['WHITE_LABEL']);
    }
  });
});

/** S13-F25: a backfill page's batch record. */
async function batchRecord(pageKey: string) {
  const res = await withSystem('wl.test', (tx) =>
    tx.execute<{ state: string; provider_batch_id: string | null; items: unknown[] }>(
      sql`select state, provider_batch_id, items from white_label_batches where page_key = ${pageKey}`,
    ),
  );
  return res.rows[0];
}

/** S13-F25: drops a page's batch record (a fixed page key another run of the suite may have used). */
async function batchCleared(pageKey: string) {
  await withSystem('wl.test', (tx) => tx.execute(sql`delete from white_label_batches where page_key = ${pageKey}`));
}
