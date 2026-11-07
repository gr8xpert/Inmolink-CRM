import { CreateListingBody, PutListingTranslationBody, UpdateListingBody, WINDOW_CARDS_MAX } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configurePdf } from '@inmolink/platform/pdf';
import { fakePdfRenderer } from '@inmolink/platform/pdf/testing';
import { closeQueues, configureQueue, type PoolHandle, queueFor, registerPool } from '@inmolink/platform/queue';
import { configureStorage, createMemoryStore, type MemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, purgeReferenceFixtures } from '../../../testing/factories';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../../website-api';
import * as presentations from '../index';
import { windowCardsKey } from '../window-cards';

/**
 * Window cards (R2-06) through the real `pdf` pool (a fake renderer keeping the HTML, the in-memory store): a batch of
 * 50 is ONE job and ONE file; every card's QR code opens that listing's live, branded, white-labelled page.
 */

const RUN = newId().slice(-8).toLowerCase();
const PREFIX = `wc-${RUN.replace(/[^a-z0-9]/g, '')}-`;
const log = createLogger({ service: 'window-cards-test', level: 'silent' });

let a: Founder;
let b: Founder;
let c: Founder;
let ids: { city: string; villa: string };
let store: MemoryStore;
let pool: PoolHandle;
let fake: ReturnType<typeof fakePdfRenderer>;
const own: string[] = [];
let network = '';

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('window-cards.test', fn);
const run =
  (m: Founder): CtxRunner =>
  (fn) =>
    as(m, fn);

async function listing(m: Founder, n: number, text: { title: string; description: string }): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 45_000_000 + n * 100_000,
        energyRating: 'B',
        bedrooms: 3,
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.saveListingTranslation(
      ctx,
      id,
      'en',
      PutListingTranslationBody.parse({ version: (await properties.getListing(ctx, id)).version, ...text }),
    ),
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
  return id;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureCache({ prefix: `t:wc:${RUN}` });
  await configureQueue({ prefix: `test-wc-${RUN}`, logger: log });
  store = createMemoryStore();
  configureStorage(store);
  fake = fakePdfRenderer();
  configurePdf(fake);
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  search.configureNetworkSearch({ giveToGetMinShared: 1, giveToGetGraceDays: 0 });
  presentations.configurePresentations({
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
    publicBaseUrl: 'https://sites.example',
  });
  [a, b, c] = [await createFounder(), await createFounder(), await createFounder()];
  for (const m of [a, b, c]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  for (const [m, n] of [
    [a, 'Alpha'],
    [b, 'Beta'],
  ] as const) {
    await system((tx) =>
      tx.execute(sql`update agency_directory set name = ${`${n} Homes ${RUN}`} where agency_id = ${m.agencyId}`),
    );
  }
  ids = await system(async (tx) => {
    const tr = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${PREFIX}${n.toLowerCase()}` }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `${PREFIX}c`,
      translations: tr('Cardland'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: country,
        code: `${PREFIX}r`,
        translations: tr('Coast'),
      }),
      code: `${PREFIX}y`,
      translations: tr('Cardton'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: `${PREFIX}g`, sort: 0, translations: tr('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `${PREFIX}v`,
      sort: 0,
      translations: tr('Villa'),
    });
    return { city, villa };
  });
  for (let i = 0; i < WINDOW_CARDS_MAX - 1; i++) {
    own.push(await listing(a, i, { title: `Sea villa ${i} ${RUN}`, description: 'Bright villa near the beach.' }));
  }
  network = await listing(b, 99, {
    title: `Golf house ${RUN}`,
    description: `Lovely house. Call owner-${RUN}@owner.example today.`,
  });
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [...own, network]));
  pool = registerPool('pdf', [presentations.presentationsJobs.renderWindowCards], { concurrency: 4, groupRetryMs: 20 });
}, 300_000);

afterAll(async () => {
  await pool?.close();
  await queueFor('pdf')
    .obliterate({ force: true })
    .catch(() => undefined);
  configurePdf(undefined);
  await purgeReferenceFixtures(PREFIX).catch(() => undefined);
  await closeQueues();
  await closeCache();
  await closeDb();
});

describe('window cards (R2-06)', () => {
  it('[R2-06] a batch of 50 renders in ONE job and ONE file; every QR resolves to the branded, white-labelled listing page', async () => {
    const all = [...own, network];
    expect(all).toHaveLength(50);
    const rssBefore = process.memoryUsage().rss;
    const t0 = Date.now();
    const rendersBefore = fake.documents.length;
    const asked = await presentations.requestWindowCards(run(a), {
      listingIds: all,
      template: 'classic-a4-p',
      locale: 'en',
    });
    const done = await until(
      () => presentations.getWindowCards(run(a), asked.id),
      (d) => d.status !== 'PENDING',
    );
    const ms = Date.now() - t0;
    const rssMb = Math.round((process.memoryUsage().rss - rssBefore) / 1_048_576);
    console.info(
      `window cards: 50 cards in ${ms} ms, RSS delta ${rssMb} MB, RSS ${Math.round(process.memoryUsage().rss / 1_048_576)} MB`,
    );
    expect(done).toMatchObject({ id: asked.id, status: 'READY' });
    expect(done.url).toEqual(expect.any(String));
    expect(await store.head('private', windowCardsKey(a.agencyId, asked.id, 'PDF'))).not.toBeNull();
    // one job, one render, one page per card, a QR on each
    expect(fake.documents.length).toBe(rendersBefore + 1);
    const html = fake.documents.at(-1) as string;
    expect(html.match(/<section class="card"/g)).toHaveLength(50);
    expect(html.match(/<svg[ >]/g)?.length).toBeGreaterThanOrEqual(50);
    expect(html).toContain('size: 210mm 297mm');
    // white label: the presenting agency, never the owner's name or contact
    expect(html).toContain(`Alpha Homes ${RUN}`);
    expect(html).not.toContain(`Beta Homes ${RUN}`);
    expect(html).not.toContain(`owner-${RUN}`);
    expect(html).toContain(`Golf house ${RUN}`);

    // the QR targets: each listing's own live page, branded by the requesting agency
    const { urls } = await presentations.windowCardsBatchHtml({
      documentId: asked.id,
      agencyId: a.agencyId,
      createdBy: a.userId,
      template: 'classic-a4-p',
      format: 'PDF',
      locale: 'en',
      listingIds: all,
    });
    expect(urls.size).toBe(50);
    const url = urls.get(network) as string;
    expect(url).toMatch(/^https:\/\/sites\.example\/s\/[A-Za-z0-9_-]{43}$/);
    const page = await presentations.selectionPage(url.split('/s/')[1] as string);
    expect(page.presenter.name).toBe(`Alpha Homes ${RUN}`);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.targetId).toBe(network);
    expect(page.items[0]?.detail?.title).toBe(`Golf house ${RUN}`);
    expect(JSON.stringify(page)).not.toContain(`owner-${RUN}`);
    // printing again lands on the same pages (no new selections per print run)
    const again = await presentations.windowCardsBatchHtml({
      documentId: asked.id,
      agencyId: a.agencyId,
      createdBy: a.userId,
      template: 'bold-a3-l',
      format: 'PDF',
      locale: 'en',
      listingIds: all,
    });
    expect([...again.urls.values()].sort()).toEqual([...urls.values()].sort());
  }, 120_000);

  it('[R2-06] the same request is the same document, nothing rendered twice; HTML output; another agency cannot read it', async () => {
    const body = { listingIds: own.slice(0, 3), template: 'gallery-a3-p', locale: 'en' } as const;
    const first = await presentations.requestWindowCards(run(a), body);
    await until(
      () => presentations.getWindowCards(run(a), first.id),
      (d) => d.status !== 'PENDING',
    );
    const renders = fake.documents.length;
    const again = await presentations.requestWindowCards(run(a), body);
    expect(again).toMatchObject({ id: first.id, status: 'READY' });
    expect(fake.documents.length).toBe(renders);
    expect(await refusal(presentations.getWindowCards(run(c), first.id))).toBe('DOCUMENT_NOT_FOUND');

    const asHtml = await presentations.requestWindowCards(run(a), { ...body, format: 'HTML' });
    expect(asHtml.id).not.toBe(first.id);
    const done = await until(
      () => presentations.getWindowCards(run(a), asHtml.id),
      (d) => d.status !== 'PENDING',
    );
    expect(done.status).toBe('READY');
    const stored = await store.head('private', windowCardsKey(a.agencyId, asHtml.id, 'HTML'));
    expect(stored).not.toBeNull();
    expect(fake.documents.length).toBe(renders); // HTML needs no browser
  });

  it('[R2-06] only public listings the agency may show are accepted; an unknown template is refused', async () => {
    expect(
      await refusal(
        presentations.requestWindowCards(run(a), {
          listingIds: [newId()],
          template: 'classic-a4-p',
        }),
      ),
    ).toBe('DOCUMENT_LISTINGS_INVALID');
    expect(
      await refusal(
        presentations.requestWindowCards(run(a), { listingIds: [own[0] as string], template: 'nope' as never }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});
