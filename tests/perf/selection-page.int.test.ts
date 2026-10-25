import { CreateListingBody, CreateSelectionBody, UpdateListingBody } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as presentations from '@inmolink/core/modules/presentations';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * The selection page at its limit (S13-F10 · S12-04): 50 items, half the agency's own and half another agency's
 * network listings, white-labelled and live (`presentations.selectionPage`, what `GET /s/<token>` renders). Budgets:
 * p95 < 150 ms for the page, ≤ 5 statements, each statement's execution (EXPLAIN ANALYZE as `app_public`) p95 < 20 ms.
 * The selection and its listings are this run's own (unique agencies); the selection is deleted afterwards.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-selperf-${RUN}`;
const ITEMS = 50;
const REQUESTS = 40;
const EXPLAINED = 20;
const PAGE_BUDGET_MS = 150;
const STATEMENT_BUDGET_MS = 20;
const STATEMENTS = 5;

let a: Founder;
let b: Founder;
let token = '';
let selectionId = '';
const log = createLogger({ service: 'perf', level: 'info' });
const p95 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.ceil(xs.length * 0.95) - 1] as number;
const as = <T>(m: Founder, fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:selperf:${RUN}`, commandTimeoutMs: 2_000 });
  presentations.configurePresentations({
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
    publicBaseUrl: 'https://sites.example',
  });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  a = await createFounder();
  b = await createFounder();
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const ids = await withSystem('perf.selection-page', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Selperf'),
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
    return { city, villa };
  });
  const listing = async (m: Founder, i: number): Promise<string> => {
    const { id } = await as(m, (ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 20_000_000 + i * 500_000,
          bedrooms: 1 + (i % 5),
          energyRating: 'B',
        }),
      ),
    );
    for (const locale of ['en', 'es']) {
      await as(m, async (ctx) =>
        properties.saveListingTranslation(ctx, id, locale, {
          version: (await properties.getListing(ctx, id)).version,
          title: `Villa ${i} ${RUN}`,
          description: `Villa with ${1 + (i % 5)} bedrooms near the sea. Call Ownerhaus on +34 955 512 345 or ask for Marisol.`,
        }),
      );
    }
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
    return id;
  };
  const own: string[] = [];
  const network: string[] = [];
  for (let i = 0; i < ITEMS / 2; i++) {
    own.push(await listing(a, i));
    network.push(await listing(b, i));
  }
  await withSystem('perf.selection-page', (tx) => search.rebuildReadModels(tx, 'LISTING', [...own, ...network]));
  // Own and network interleaved, a note on every other item.
  const items = Array.from({ length: ITEMS }, (_, i) => ({
    targetId: (i % 2 === 0 ? own : network)[Math.floor(i / 2)] as string,
    ...(i % 2 === 1 ? { note: 'Lovely, close to the beach' } : {}),
  }));
  const made = await as(a, (ctx) =>
    presentations.createSelection(ctx, CreateSelectionBody.parse({ title: `Perf ${RUN}`, locale: 'en', items })),
  );
  expect(made.selection.items).toHaveLength(ITEMS);
  token = made.share.token;
  selectionId = made.selection.id;
}, 600_000);

afterAll(async () => {
  await withSystem('perf.selection-page', (tx) =>
    tx.execute(sql`delete from selections where id = ${selectionId}`),
  ).catch(() => undefined);
  await closeCache();
  await closeDb();
});

it('[S13-F10] selection page of 50 items (own + network): p95 < 150 ms, ≤ 5 statements, each SQL p95 < 20 ms', async () => {
  const warm = await presentations.selectionPage(token);
  expect(warm.items).toHaveLength(ITEMS);
  expect(warm.items.every((i) => i.detail !== null)).toBe(true);
  // The page: wall time and statement count, one at a time.
  const ms: number[] = [];
  let maxStatements = 0;
  for (let i = 0; i < REQUESTS; i++) {
    const started = performance.now();
    const statements = await countQueries(async () => {
      await presentations.selectionPage(token);
    });
    ms.push(performance.now() - started);
    maxStatements = Math.max(maxStatements, statements);
  }
  // Each statement's own execution (EXPLAIN ANALYZE as app_public, in a rolled-back transaction), per position.
  const captured: { query: string; params: unknown[] }[] = [];
  await countQueries(
    async () => {
      await presentations.selectionPage(token);
    },
    { onQuery: (query, params) => captured.push({ query, params }) },
  );
  const perStatement: number[][] = captured.map(() => []);
  for (let run = 0; run < EXPLAINED; run++) {
    await withAdminRollback([], async (q) => {
      await q('set local role app_public');
      for (const [i, s] of captured.entries()) {
        const plan = await q(`explain (analyze, costs off) ${s.query}`, s.params);
        const text = plan.map((x) => String(Object.values(x)[0])).join('\n');
        perStatement[i]?.push(Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1]));
      }
    });
  }
  const statementP95 = perStatement.map((xs, i) => ({
    statement: (captured[i]?.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 70),
    p95Ms: Math.round(p95(xs) * 100) / 100,
  }));
  log.info(
    {
      items: ITEMS,
      requests: REQUESTS,
      pageP95Ms: Math.round(p95(ms)),
      pageMeanMs: Math.round(ms.reduce((x, y) => x + y, 0) / ms.length),
      maxStatements,
      statementP95,
    },
    '[S13-F10] selection page',
  );
  expect(maxStatements).toBeLessThanOrEqual(STATEMENTS);
  for (const s of statementP95) expect(s.p95Ms, s.statement).toBeLessThan(STATEMENT_BUDGET_MS);
  expect(p95(ms)).toBeLessThan(PAGE_BUDGET_MS);
}, 300_000);
