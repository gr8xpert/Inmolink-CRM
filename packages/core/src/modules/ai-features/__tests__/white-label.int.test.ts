import { fileURLToPath } from 'node:url';
import { CreateListingBody, type CreateSiteInput, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, withPublicRead, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureAi, createAiGateway, filePromptSource } from '@inmolink/platform/ai';
import { FakeProvider, memoryAiCache, memoryAiStore } from '@inmolink/platform/ai/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import { whiteLabelLeaks } from '../../../testing/white-label';
import { blocksOf } from '../../../testing/white-label-fixtures';
import { readAiRemovalEntries } from '../../../white-label-store';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../../website-api';
import * as websites from '../../websites';
import { sanitizeTargetTexts, whiteLabelJobs } from '../index';

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
