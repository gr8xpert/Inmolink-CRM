import { CreateListingBody, PutListingTranslationBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configurePdf, type PdfRenderer } from '@inmolink/platform/pdf';
import { fakePdfRenderer } from '@inmolink/platform/pdf/testing';
import { closeQueues, configureQueue, type PoolHandle, queueFor, registerPool } from '@inmolink/platform/queue';
import { configureStorage, createMemoryStore, type MemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, purgeReferenceFixtures } from '../../../testing/factories';
import * as presentations from '../../presentations';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../../website-api';
import * as documents from '../index';

/**
 * PDF brochures and portfolios (S12-05) through the `pdf` pool (a real pool on this file's queue prefix, a fake
 * renderer that keeps the HTML, the in-memory store): what is rendered, white-labelled; the document's state and
 * signed link; renders capped per agency.
 */

const RUN = newId().slice(-8).toLowerCase();
const PREFIX = `docs-${RUN.replace(/[^a-z0-9]/g, '')}-`;
const log = createLogger({ service: 'documents-test', level: 'silent' });

/** a: asks for documents · b: owns a network listing with leaky text · c: another agency. */
let a: Founder;
let b: Founder;
let c: Founder;
let ids: { city: string; villa: string };
const L: Record<string, string> = {};
let store: MemoryStore;
let pool: PoolHandle;
/** Renders by agency name (the band of every page): running now and the most at once. */
const running = new Map<string, number>();
const most = new Map<string, number>();
let delayMs = 0;
let fake: ReturnType<typeof fakePdfRenderer>;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('documents.test', fn);
/** A member's request: each call in its own transaction, like a route's `withCtx`. */
const run =
  (m: Founder): CtxRunner =>
  (fn) =>
    as(m, fn);

async function listing(
  m: Founder,
  body: Partial<CreateListingBody>,
  text: { title: string; description: string },
  state: Pick<UpdateListingBody, 'visibility' | 'shareScope'>,
): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 45_000_000,
        energyRating: 'B',
        bedrooms: 3,
        ...body,
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
      UpdateListingBody.parse({ status: 'ACTIVE', ...state, version: (await properties.getListing(ctx, id)).version }),
    ),
  );
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  return id;
}

const agencyOf = (html: string) => /class="agency">([^<]*)</.exec(html)?.[1] ?? '';

/** The fake renderer, counting concurrent renders per presenting agency. */
function countingRenderer(): PdfRenderer {
  fake = fakePdfRenderer();
  return {
    get active() {
      return fake.active;
    },
    async render(html, options) {
      const who = agencyOf(html);
      const n = (running.get(who) ?? 0) + 1;
      running.set(who, n);
      most.set(who, Math.max(most.get(who) ?? 0, n));
      try {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        return await fake.render(html, options);
      } finally {
        running.set(who, (running.get(who) ?? 1) - 1);
      }
    },
    close: async () => undefined,
  };
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

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
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
  await configureCache({ prefix: `t:docs:${RUN}` });
  await configureQueue({ prefix: `test-docs-${RUN}`, logger: log });
  store = createMemoryStore();
  configureStorage(store);
  configurePdf(countingRenderer());
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
  // Distinct names: the renders are counted by the presenting agency's name.
  for (const [m, n] of [
    [a, 'Alpha'],
    [b, 'Beta'],
    [c, 'Gamma'],
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
      translations: tr('Docland'),
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
      translations: tr('Docton'),
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
  L.aOwn = await listing(
    a,
    {},
    { title: `Sea villa ${RUN}`, description: 'Bright villa <b>near</b> the beach.' },
    { visibility: 'PUBLIC', shareScope: 'ALL' },
  );
  L.bNetwork = await listing(
    b,
    { priceCents: 61_000_000 },
    {
      title: `Golf house ${RUN}`,
      description: `Lovely golf house. Call owner-${RUN}@owner.example or visit www.owner-${RUN}.example today.`,
    },
    { visibility: 'PUBLIC', shareScope: 'ALL' },
  );
  L.bShared = await listing(
    b,
    {},
    { title: `Quiet flat ${RUN}`, description: 'Shared with agencies only.' },
    { visibility: 'SHARED', shareScope: 'ALL' },
  );
  L.cOwn = await listing(
    c,
    {},
    { title: `Town house ${RUN}`, description: 'In town.' },
    { visibility: 'PUBLIC', shareScope: 'PREFERRED' },
  );
  pool = registerPool('pdf', [documents.documentsJobs.renderListings], { concurrency: 8, groupRetryMs: 20 });
}, 180_000);

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

describe('PDF documents (S12-05)', () => {
  it('[S12-05] a portfolio renders in the pdf pool: branded, prices and status from the read models, white-labelled, a signed link', async () => {
    const asked = await documents.requestPortfolio(run(a), {
      listingIds: [L.aOwn as string, L.bNetwork as string],
      locale: 'en',
    });
    expect(asked.status).not.toBe('FAILED');
    const done = await until(
      () => documents.getDocument(run(a), asked.id),
      (d) => d.status !== 'PENDING',
    );
    expect(done).toMatchObject({ id: asked.id, status: 'READY' });
    expect(done.url).toEqual(expect.any(String));
    expect(await store.head('private', documents.documentKey(a.agencyId, asked.id))).not.toBeNull();
    const html = fake.documents.at(-1) as string;
    // The requesting agency presents both listings; prices from the read models, in the locale.
    expect(agencyOf(html)).not.toBe('');
    expect(html).toContain(`Sea villa ${RUN}`);
    expect(html).toContain(`Golf house ${RUN}`);
    expect(html).toContain('€450,000');
    expect(html).toContain('€610,000');
    // The owner's contact details never reach the client; markup in the text is escaped, never rendered.
    expect(html).not.toContain(`owner-${RUN}`);
    expect(html).not.toContain(`Beta Homes ${RUN}`);
    expect(html).toContain(`Alpha Homes ${RUN}`);
    expect(html).not.toContain('<b>near</b>');
    // The same request again is the same document: nothing rendered twice.
    const renders = fake.documents.length;
    const again = await documents.requestPortfolio(run(a), {
      listingIds: [L.aOwn as string, L.bNetwork as string],
      locale: 'en',
    });
    expect(again).toMatchObject({ id: asked.id, status: 'READY' });
    expect(fake.documents.length).toBe(renders);
  });

  it('[S12-05] a brochure in Spanish; another agency cannot read the document', async () => {
    const asked = await documents.requestBrochure(run(a), { listingId: L.aOwn as string, locale: 'es' });
    const done = await until(
      () => documents.getDocument(run(a), asked.id),
      (d) => d.status !== 'PENDING',
    );
    expect(done.status).toBe('READY');
    const html = fake.documents.at(-1) as string;
    expect(html).toContain('lang="es"');
    expect(html).toMatch(/450\.000\s€/);
    expect(await refusal(documents.getDocument(run(c), asked.id))).toBe('DOCUMENT_NOT_FOUND');
    expect(await refusal(documents.getDocument(run(a), '0'.repeat(32)))).toBe('DOCUMENT_NOT_FOUND');
  });

  it('[S12-05] only listings the agency may show: an invisible one is refused, a non-public one fails without retry', async () => {
    // c's listing is shared with preferred partners only: a cannot see it.
    expect(await refusal(documents.requestBrochure(run(a), { listingId: L.cOwn as string, locale: 'en' }))).toBe(
      'DOCUMENT_LISTINGS_INVALID',
    );
    // b's listing is shared with agencies but not public: a sees it, a client document cannot show it.
    const asked = await documents.requestBrochure(run(a), { listingId: L.bShared as string });
    const done = await until(
      () => documents.getDocument(run(a), asked.id),
      (d) => d.status !== 'PENDING',
    );
    expect(done).toMatchObject({ status: 'FAILED', url: null });
    // Asking again queues it afresh (a failed job is not left blocking its id for days).
    const again = await documents.requestBrochure(run(a), { listingId: L.bShared as string });
    expect(again).toMatchObject({ id: asked.id, status: 'PENDING' });
    expect(
      (
        await until(
          () => documents.getDocument(run(a), asked.id),
          (d) => d.status !== 'PENDING',
        )
      ).status,
    ).toBe('FAILED');
  });

  it("[S12-05] a selection as a PDF: its items in order, under its title, in the client's language", async () => {
    const { selection } = await as(a, (ctx) =>
      presentations.createSelection(ctx, {
        title: `For Ana ${RUN}`,
        locale: 'en',
        items: [{ targetId: L.bNetwork as string }, { targetId: L.aOwn as string }],
      }),
    );
    const asked = await presentations.selectionPdf(run(a), selection.id);
    const done = await until(
      () => documents.getDocument(run(a), asked.id),
      (d) => d.status !== 'PENDING',
    );
    expect(done.status).toBe('READY');
    const html = fake.documents.at(-1) as string;
    expect(html).toContain(`For Ana ${RUN}`);
    expect(html.indexOf(`Golf house ${RUN}`)).toBeLessThan(html.indexOf(`Sea villa ${RUN}`));
    expect(html).not.toContain(`owner-${RUN}`);
    expect(await refusal(presentations.selectionPdf(run(c), selection.id))).toBe('SELECTION_NOT_FOUND');
  });

  it('[S12-05] concurrent renders are capped per agency; another agency is not held up', async () => {
    delayMs = 150;
    running.clear();
    most.clear();
    try {
      const mine = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          documents.requestPortfolio(run(a), { listingIds: [L.aOwn as string], title: `Batch ${i} ${RUN}` }),
        ),
      );
      const theirs = await Promise.all(
        Array.from({ length: 2 }, (_, i) =>
          documents.requestPortfolio(run(c), { listingIds: [L.cOwn as string], title: `Other ${i} ${RUN}` }),
        ),
      );
      const ready = async (m: Founder, id: string) =>
        until(
          () => documents.getDocument(run(m), id),
          (d) => d.status !== 'PENDING',
        );
      const finishedAt = new Map<string, number>();
      await Promise.all([
        ...mine.map(async (d) => {
          expect((await ready(a, d.id)).status).toBe('READY');
          finishedAt.set(d.id, Date.now());
        }),
        ...theirs.map(async (d) => {
          expect((await ready(c, d.id)).status).toBe('READY');
          finishedAt.set(d.id, Date.now());
        }),
      ]);
      const nameOf = async (m: Founder, id: string) =>
        (await documents.loadDocumentListings({ agencyId: m.agencyId, listingIds: [id], locale: 'en' })).presenter.name;
      const [aName, cName] = [await nameOf(a, L.aOwn as string), await nameOf(c, L.cOwn as string)];
      expect(aName).not.toBe(cName);
      for (const [who, n] of most) expect(n, who).toBeLessThanOrEqual(documents.DOCUMENT_RENDERS_PER_AGENCY);
      // The busy agency did hit its cap; the other agency's two finished before the busy one's six.
      expect(most.get(aName)).toBe(documents.DOCUMENT_RENDERS_PER_AGENCY);
      expect(most.get(cName)).toBeGreaterThanOrEqual(1);
      const lastOfTheirs = Math.max(...theirs.map((d) => finishedAt.get(d.id) ?? 0));
      const lastOfMine = Math.max(...mine.map((d) => finishedAt.get(d.id) ?? 0));
      expect(lastOfTheirs).toBeLessThan(lastOfMine);
    } finally {
      delayMs = 0;
    }
  }, 60_000);
});
