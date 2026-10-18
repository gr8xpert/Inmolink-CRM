import {
  CreateDevelopmentBody,
  CreateListingBody,
  CreateUnitsBody,
  ListingCardDoc,
  ListingDetailDoc,
  PutListingTranslationBody,
  SetDevelopmentAccessBody,
  UnitCardDoc,
  UnitDetailDoc,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withPublicRead, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { configureSearch, createMeiliEngine, type SearchEngine, SearchError } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as developments from '../../developments';
import * as media from '../../media';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import { etagOf } from '../build';
import * as search from '../index';
import * as repo from '../repo';

/** Listing and unit read models on the real database (S5-01, PATTERNS §14). */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const log = createLogger({ service: 'search.test', level: 'silent' });
const jobCtx = () => ({
  log,
  jobId: newId(),
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

let a: Founder;
let ids: { country: string; city: string; type: string; feature: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('search.read-models.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const docs = (id: string, locale?: string) => system((tx) => search.readModelDocs(tx, [id], locale));
const build = (kind: search.ReadModelKind, id: string) => system((tx) => search.rebuildReadModels(tx, kind, [id]));

type Queued = { job: string; payload: unknown };

/**
 * The worker's part: delivers the agency's pending events to the search subscriptions and answers the jobs they
 * queued (not run), in event order, so a test can run them in any order.
 */
async function deliver(m: Founder): Promise<Queued[]> {
  const queued: Queued[] = [];
  const spies = [
    vi.spyOn(search.searchJobs.buildReadModel, 'enqueue').mockImplementation(async (payload) => {
      queued.push({ job: 'buildReadModel', payload });
      return { id: 'test' };
    }),
    vi.spyOn(search.searchJobs.buildDevelopmentReadModels, 'enqueue').mockImplementation(async (payload) => {
      queued.push({ job: 'buildDevelopmentReadModels', payload });
      return { id: 'test' };
    }),
    vi.spyOn(search.searchJobs.buildAgencyReadModels, 'enqueue').mockImplementation(async (payload) => {
      queued.push({ job: 'buildAgencyReadModels', payload });
      return { id: 'test' };
    }),
  ];
  search.registerSearchSubscriptions();
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
        if (s.name.startsWith('search.')) await s.handler(e.payload as never, meta);
      }
    }
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
  } finally {
    search.unregisterSearchSubscriptions();
    for (const s of spies) s.mockRestore();
  }
  return queued;
}

/** Runs queued jobs (a recheck or index sync they queue in turn is only recorded). */
async function run(jobs: Queued[]): Promise<void> {
  const enqueue = vi.spyOn(search.searchJobs.buildReadModel, 'enqueue').mockResolvedValue({ id: 'test' });
  const sync = vi.spyOn(search.searchJobs.syncIndex, 'enqueue').mockResolvedValue({ id: 'test' });
  try {
    for (const { job, payload } of jobs) {
      const def = search.searchJobs[job as keyof typeof search.searchJobs];
      await def.spec.run(def.spec.payload.parse(payload) as never, jobCtx());
    }
  } finally {
    enqueue.mockRestore();
    sync.mockRestore();
  }
}

async function createListing(m: Founder, extra: Partial<CreateListingBody> = {}): Promise<string> {
  const dto = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.city, priceCents: 45_000_000, ...extra }),
    ),
  );
  return dto.id;
}
const versionOf = async (m: Founder, id: string) => (await as(m, (ctx) => properties.getListing(ctx, id))).version;
const update = async (m: Founder, id: string, patch: Omit<UpdateListingBody, 'version'>) =>
  as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ ...patch, version: (await properties.getListing(ctx, id)).version }),
    ),
  );
const translate = async (m: Founder, id: string, locale: string, title: string, description = `${title} text`) =>
  as(m, async (ctx) =>
    properties.saveListingTranslation(
      ctx,
      id,
      locale,
      PutListingTranslationBody.parse({ version: (await properties.getListing(ctx, id)).version, title, description }),
    ),
  );
/** A SHARED, ACTIVE listing with an English translation. */
async function sharedListing(m: Founder, extra: Partial<CreateListingBody> = {}): Promise<string> {
  const id = await createListing(m, extra);
  await translate(m, id, 'en', `Villa ${RUN}`);
  await update(m, id, { status: 'ACTIVE', visibility: 'SHARED' });
  return id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  media.configureMedia({ urlKey: `search-test-key-${RUN}-0123456789abcdef` });
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  await rows(sql`update agency_settings set enabled_locales = '{en,es,de}' where agency_id = ${a.agencyId}`);
  ids = await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('rm'),
      translations: [
        { locale: 'en', name: `Readland ${RUN}`, slug: code('readland') },
        { locale: 'es', name: `Lectura ${RUN}`, slug: code('lectura') },
      ],
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('rm-r'),
      translations: [{ locale: 'en', name: `North ${RUN}`, slug: code('north') }],
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('rm-c'),
      translations: [{ locale: 'en', name: `Docton ${RUN}`, slug: code('docton') }],
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('rm-houses'),
      sort: 0,
      translations: [{ locale: 'en', name: `Houses ${RUN}`, slug: code('rm-houses') }],
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('rm-villa'),
      sort: 0,
      translations: [
        { locale: 'en', name: `Villa ${RUN}`, slug: code('rm-villa') },
        { locale: 'es', name: `Chalet ${RUN}`, slug: code('rm-chalet') },
      ],
    });
    const featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: code('rm-outdoor'),
      sort: 0,
      translations: [{ locale: 'en', name: `Outdoor ${RUN}`, slug: code('rm-outdoor') }],
    });
    const feature = await taxonomy.createFeature(tx, {
      groupId: featureGroup,
      key: code('rm-pool'),
      icon: 'pool',
      sort: 0,
      translations: [{ locale: 'en', name: `Pool ${RUN}`, slug: code('rm-pool') }],
    });
    return { country, city, type, feature };
  });
}, 120_000);

afterAll(async () => {
  await system(async (tx) => {
    await tx.execute(sql`delete from listing_read_models where agency_id = ${a.agencyId}`);
    await tx.execute(sql`delete from units where agency_id = ${a.agencyId}`);
    await tx.execute(sql`delete from developments where agency_id = ${a.agencyId}`);
    await tx.execute(sql`delete from properties where agency_id = ${a.agencyId}`);
  });
  await closeDb();
});

describe('listing read models', () => {
  it('[S5-01] builds a card and detail per content locale of the owner agency, with fallback text and names', async () => {
    const id = await sharedListing(a, { bedrooms: 3, builtM2: 180.5 });
    await translate(a, id, 'es', `Casa ${RUN}`);
    await as(a, async (ctx) =>
      properties.setListingFeatures(ctx, id, {
        version: (await properties.getListing(ctx, id)).version,
        featureIds: [ids.feature],
      }),
    );
    const queued = await deliver(a);
    expect(queued.every((q) => q.job === 'buildReadModel')).toBe(true);
    await run(queued);

    const stored = await docs(id);
    expect(stored.map((d) => d.locale).sort()).toEqual(['de', 'en', 'es']);
    const by = Object.fromEntries(stored.map((d) => [d.locale, d]));
    const en = ListingDetailDoc.parse(by.en?.detail);
    expect(en).toMatchObject({
      kind: 'LISTING',
      id,
      title: `Villa ${RUN}`,
      textLocale: null,
      bedrooms: 3,
      builtM2: 180.5,
      propertyType: { id: ids.type, name: `Villa ${RUN}` },
      place: {
        country: { name: `Readland ${RUN}` },
        region: { name: `North ${RUN}` },
        city: { name: `Docton ${RUN}` },
        area: null,
      },
      features: [{ id: ids.feature, name: `Pool ${RUN}` }],
    });
    const es = ListingDetailDoc.parse(by.es?.detail);
    expect(es).toMatchObject({ title: `Casa ${RUN}`, textLocale: null, propertyType: { name: `Chalet ${RUN}` } });
    expect(es.place.country?.name).toBe(`Lectura ${RUN}`);
    // German: no translation — the fallback content locale's text, and says so.
    const de = ListingCardDoc.parse(by.de?.card);
    expect(de.textLocale).not.toBeNull();
    expect(by.en?.public).toBe(false); // SHARED: network only, never a public path
    expect(by.en?.etag).toMatch(/^[A-Za-z0-9_-]{27}$/);
    expect(by.en?.version).toBe(await versionOf(a, id));
  });

  it('[S5-01] read model never goes backwards in version under out-of-order events', async () => {
    const id = await sharedListing(a);
    await run(await deliver(a));
    // Three edits; their events are delivered and their jobs run newest first, then the oldest again.
    await update(a, id, { priceCents: 50_000_000 });
    await update(a, id, { priceCents: 51_000_000 });
    await update(a, id, { priceCents: 52_000_000 });
    const latest = await versionOf(a, id);
    const queued = await deliver(a);
    expect(queued.length).toBeGreaterThanOrEqual(3);
    await run([...queued].reverse());
    await run([queued[0] as Queued]);
    for (const d of await docs(id)) {
      expect(d.version).toBe(latest);
      expect(ListingCardDoc.parse(d.card).price.amountCents).toBe(52_000_000);
    }

    // A builder that read older data than the stored document cannot write it: a lower version is refused, and
    // the same version only with other content (media processed, a rename) — never anything older.
    const [current] = await docs(id, 'en');
    const stale = ListingCardDoc.parse(current?.card);
    const older = { ...stale, price: { ...stale.price, amountCents: 50_000_000 } };
    const written = await system((tx) =>
      repo.upsertDocs(tx, [
        {
          targetId: id,
          locale: 'en',
          kind: 'LISTING',
          agencyId: a.agencyId,
          developmentId: null,
          public: false,
          status: 'ACTIVE',
          shareScope: 'ALL',
          version: latest - 2,
          card: older,
          detail: current?.detail as never,
          etag: etagOf(older, current?.detail),
        },
      ]),
    );
    expect(written).toEqual([]);
    expect((await docs(id, 'en'))[0]?.version).toBe(latest);

    // Concurrent rebuilds of one listing (a slow job and a fresh one) are serialised: the result is the latest.
    await update(a, id, { priceCents: 53_000_000 });
    const after = await versionOf(a, id);
    await Promise.all(Array.from({ length: 5 }, () => build('LISTING', id)));
    for (const d of await docs(id)) {
      expect(d.version).toBe(after);
      expect(ListingCardDoc.parse(d.card).price.amountCents).toBe(53_000_000);
    }
    // An unchanged rebuild writes nothing.
    expect((await build('LISTING', id)).written).toBe(0);
  });

  it('[S5-01] detail JSON contains no owner contact or private fields', async () => {
    const secret = `SECRET-${RUN}`;
    const id = await sharedListing(a, {
      cadastralRef: `CAD${RUN}`,
      internalNotes: `notes ${secret}`,
      keysInfo: `keys ${secret}`,
      coordinates: { lat: 36.512345, lng: -4.887654 },
      locationPrecision: 'APPROX',
      commission: { type: 'PCT', basisPoints: 437, includesVat: false },
      splitBp: 3_333,
      energyRating: 'B',
    });
    await rows(
      sql`insert into property_tags (property_id, agency_id, tag) values (${id}, ${a.agencyId}, ${`tag-${RUN}`})`,
    );
    await rows(
      sql`update property_privates set external_source = 'KYERO', external_ref = ${`EXT${RUN}`}, quality_score = 77,
            seller_contact_id = ${newId()} where property_id = ${id}`,
    );
    await build('LISTING', id);
    const [listing] = await rows<{ owner_user_id: string; agency_id: string }>(
      sql`select owner_user_id, agency_id from properties where id = ${id}`,
    );
    const [privates] = await rows<{ seller_contact_id: string }>(
      sql`select seller_contact_id from property_privates where property_id = ${id}`,
    );
    for (const d of await docs(id)) {
      // Strict shapes: an unknown field fails to parse.
      ListingCardDoc.parse(d.card);
      const detail = ListingDetailDoc.parse(d.detail);
      const json = JSON.stringify([d.card, d.detail]);
      for (const value of [
        secret,
        `CAD${RUN}`,
        `EXT${RUN}`,
        `tag-${RUN}`,
        '36.512345',
        '-4.887654',
        listing?.owner_user_id,
        listing?.agency_id,
        privates?.seller_contact_id,
        a.email,
        a.userId,
      ]) {
        expect(json).not.toContain(String(value));
      }
      for (const key of [
        'commission',
        'commissionBp',
        'splitBp',
        'ownerUserId',
        'agencyId',
        'cadastralRef',
        'internalNotes',
        'keysInfo',
        'exactLat',
        'sellerContactId',
        'qualityScore',
        'externalRef',
        'tags',
        'lockedFields',
        'visibility',
        'shareScope',
      ]) {
        expect(json).not.toContain(`"${key}"`);
      }
      expect(detail.energyRating).toBe('B');
      expect(detail.geo?.precision).toBe('APPROX');
    }
  });

  it('[S5-01] documents are dropped when the listing goes PRIVATE, is deleted, or a locale is removed', async () => {
    const id = await sharedListing(a);
    await build('LISTING', id);
    expect(await docs(id)).toHaveLength(3);

    await rows(sql`update agency_settings set enabled_locales = '{en,es}' where agency_id = ${a.agencyId}`);
    try {
      await build('LISTING', id);
      expect((await docs(id)).map((d) => d.locale).sort()).toEqual(['en', 'es']);
    } finally {
      await rows(sql`update agency_settings set enabled_locales = '{en,es,de}' where agency_id = ${a.agencyId}`);
    }

    await update(a, id, { visibility: 'PRIVATE' });
    await run(await deliver(a));
    expect(await docs(id)).toEqual([]);

    await update(a, id, { visibility: 'SHARED' });
    await run(await deliver(a));
    expect(await docs(id)).toHaveLength(3);
    await as(a, (ctx) => properties.deleteListing(ctx, id));
    await run(await deliver(a));
    expect(await docs(id)).toEqual([]);
  });

  it('[S5-01] processed images appear with public variant keys; unprocessed ones queue a recheck', async () => {
    const id = await sharedListing(a);
    const ready = `${RUN}`.padEnd(64, 'a');
    const pending = `${RUN}`.padEnd(64, 'b');
    await rows(sql`insert into media_objects (sha256, size_bytes, content_type, pipeline, variants_ready, width, height)
      values (${ready}, 10, 'image/jpeg', 1, 31, 1600, 1200), (${pending}, 10, 'image/jpeg', null, 0, null, null)`);
    await rows(sql`insert into property_media (id, property_id, agency_id, sha256, kind, position, is_cover)
      values (${newId()}, ${id}, ${a.agencyId}, ${ready}, 'IMAGE', 0, true),
             (${newId()}, ${id}, ${a.agencyId}, ${pending}, 'IMAGE', 1, false)`);
    const enqueue = vi.spyOn(search.searchJobs.buildReadModel, 'enqueue').mockResolvedValue({ id: 'test' });
    try {
      await search.searchJobs.buildReadModel.spec.run(
        { kind: 'LISTING', id, agencyId: a.agencyId, recheck: 0 },
        jobCtx(),
      );
      expect(enqueue).toHaveBeenCalledWith(
        { kind: 'LISTING', id, agencyId: a.agencyId, recheck: 1 },
        { debounceMs: 60_000, debounceKey: `${id}.recheck` },
      );
    } finally {
      enqueue.mockRestore();
    }
    const detail = ListingDetailDoc.parse((await docs(id, 'en'))[0]?.detail);
    expect(detail.media).toHaveLength(1);
    expect(detail.cover?.variants.thumb).toMatch(/^v1\/[0-9a-f]{32}\/thumb\.webp$/);
    // Public keys are an HMAC of the hash, never the hash itself.
    expect(JSON.stringify(detail)).not.toContain(ready);
    expect(detail.imageCount).toBe(1);
    await rows(sql`delete from property_media where property_id = ${id}`);
    await rows(sql`delete from media_objects where sha256 in (${ready}, ${pending})`);
  });

  it('[S5-01] public paths (app_public) read PUBLIC listings only', async () => {
    const shared = await sharedListing(a);
    const pub = await sharedListing(a, { energyRating: 'C', energyEmissionsRating: 'C' });
    await update(a, pub, { visibility: 'PUBLIC' });
    await system((tx) => search.rebuildListingReadModels(tx, [shared, pub]));
    const seen = await withPublicRead(
      async (tx) =>
        (await tx.execute(sql`select target_id from listing_read_models where target_id in (${shared}, ${pub})`)).rows,
    );
    expect(new Set(seen.map((r) => (r as { target_id: string }).target_id))).toEqual(new Set([pub]));
  });

  it('[S5-01] full rebuild restores missing documents and drops orphans of the agency', async () => {
    const id = await sharedListing(a);
    await build('LISTING', id);
    const live = (
      await rows<{ id: string }>(sql`select id from properties where agency_id = ${a.agencyId} and deleted_at is null
        and visibility <> 'PRIVATE' and status = 'ACTIVE' order by id`)
    ).map((r) => r.id);
    expect(live.length).toBeGreaterThanOrEqual(4);
    // Orphans before the first page, between two pages (batch 2) and after the last.
    const next = (uuid: string) => {
      const hex = (BigInt(`0x${uuid.replaceAll('-', '')}`) + 1n).toString(16).padStart(32, '0');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    const orphans = ['00000000-0000-7000-8000-000000000001', next(live[1] as string), newId()];
    for (const orphan of orphans) {
      await rows(sql`insert into listing_read_models (target_id, locale, kind, agency_id, public, status, version, card, detail, etag, updated_at)
        values (${orphan}, 'en', 'LISTING', ${a.agencyId}, true, 'ACTIVE', 1, '{}', '{}', 'x', now() - interval '1 hour')`);
    }
    await rows(sql`delete from listing_read_models where target_id = ${id} and locale = 'de'`);
    const result = await search.rebuildAllReadModels({ agencyId: a.agencyId, batch: 2, concurrency: 2 });
    expect(result.LISTING.deleted).toBeGreaterThanOrEqual(orphans.length);
    for (const orphan of orphans) expect(await docs(orphan)).toEqual([]);
    expect((await docs(id)).map((d) => d.locale).sort()).toEqual(['de', 'en', 'es']);
    // Again: nothing to write.
    const again = await search.rebuildAllReadModels({ agencyId: a.agencyId, batch: 2, concurrency: 2 });
    expect(again.LISTING.written).toBe(0);
    expect(again.LISTING.deleted).toBe(0);
  });

  it('[S5-01] a batch rebuild costs a fixed number of statements, whatever its size (no N+1)', async () => {
    const one = await sharedListing(a);
    const many = [one];
    for (let i = 0; i < 4; i++) many.push(await sharedListing(a));
    const single = await countQueries(() => build('LISTING', one));
    const batch = await countQueries(() => system((tx) => search.rebuildListingReadModels(tx, many)));
    // About ten, plus the index push queued with the documents (S5-03) and the fallback rows' refresh (S5-04:
    // read, upsert, delete).
    expect(single).toBeLessThanOrEqual(14);
    expect(batch).toBe(single);
  });
});

describe('unit read models', () => {
  it('[S5-01] units carry their development text and place; access decides public; development changes rebuild them', async () => {
    const dev = await as(a, (ctx) =>
      developments.createDevelopment(
        ctx,
        CreateDevelopmentBody.parse({
          ref: code('D'),
          name: `Heights ${RUN}`,
          locationId: ids.city,
          coordinates: { lat: 36.5, lng: -4.9 },
        }),
      ),
    );
    await rows(sql`insert into development_translations (development_id, agency_id, locale, title, description, slug)
      values (${dev.id}, ${a.agencyId}, 'en', ${`Heights title ${RUN}`}, 'Sea views', ${code('heights')})`);
    const created = await as(a, (ctx) =>
      developments.createUnits(
        ctx,
        dev.id,
        CreateUnitsBody.parse({
          units: [
            {
              ref: 'A-1',
              propertyTypeId: ids.type,
              bedrooms: 2,
              priceCents: 30_000_000,
              commission: { type: 'PCT', basisPoints: 600, includesVat: false },
            },
          ],
        }),
      ),
    );
    const unitId = created.items[0]?.id as string;
    await run(await deliver(a));
    const stored = await docs(unitId);
    expect(stored.map((d) => d.locale).sort()).toEqual(['de', 'en', 'es']);
    const en = stored.find((d) => d.locale === 'en');
    UnitCardDoc.parse(en?.card);
    const detail = UnitDetailDoc.parse(en?.detail);
    expect(detail).toMatchObject({
      kind: 'UNIT',
      title: `Heights title ${RUN}`,
      description: 'Sea views',
      development: { id: dev.id, name: `Heights ${RUN}` },
      price: { amountCents: 30_000_000 },
      place: { city: { name: `Docton ${RUN}` } },
    });
    expect(JSON.stringify(en?.detail)).not.toContain('600');
    expect(en?.public).toBe(false); // PRIVATE_NETWORK by default

    // Opened: the development's events rebuild its units, now public; version grows with the development's.
    const before = en?.version as number;
    await as(a, (ctx) =>
      developments.setDevelopmentAccess(
        ctx,
        dev.id,
        SetDevelopmentAccessBody.parse({ version: dev.version, kind: 'OPEN', allowedAgencyIds: [] }),
      ),
    );
    const devJobs = await deliver(a);
    expect(devJobs.map((q) => q.job)).toContain('buildDevelopmentReadModels');
    await run(devJobs);
    const opened = (await docs(unitId, 'en'))[0];
    expect(opened?.public).toBe(true);
    expect(opened?.version).toBeGreaterThan(before);

    // Deleted development: its units' documents go.
    const current = await as(a, (ctx) => developments.getDevelopment(ctx, dev.id));
    await as(a, (ctx) => developments.deleteDevelopment(ctx, dev.id, current.version));
    await run(await deliver(a));
    expect(await docs(unitId)).toEqual([]);
  });
});

describe('listings search index (S5-02)', () => {
  const engine = () =>
    createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });
  const indexDef = search.listingsIndex(`t_listings_${RUN.replace(/[^A-Za-z0-9]/g, '')}`);
  const indexDocs = (targetIds: string[]) => system((tx) => search.indexDocsFor(tx, targetIds));

  beforeAll(() => loadStackEnv('test'));
  afterAll(async () => {
    await engine().dropIndex(indexDef.uid);
  });

  it('[S5-02] index documents are built from read models: localized text, ids and numbers, nothing client-facing', async () => {
    const id = await sharedListing(a, { bedrooms: 4, bathrooms: 3, builtM2: 210, priceCents: 89_000_000 });
    await translate(a, id, 'es', `Chalet con piscina ${RUN}`, 'Descripción larga');
    await update(a, id, { shareScope: 'PREFERRED' });
    await as(a, async (ctx) =>
      properties.setListingFeatures(ctx, id, {
        version: (await properties.getListing(ctx, id)).version,
        featureIds: [ids.feature],
      }),
    );
    await run(await deliver(a));
    const missing = newId();
    const { docs: built, missing: gone } = await indexDocs([id, missing]);
    expect(gone).toEqual([missing]);
    const doc = built[0];
    expect(doc).toMatchObject({
      id,
      kind: 'LISTING',
      ownerAgencyId: a.agencyId,
      developmentId: null,
      status: 'ACTIVE',
      visibility: 'SHARED',
      shareScope: 'PREFERRED',
      transactionType: 'SALE',
      propertyTypeId: ids.type,
      featureIds: [ids.feature],
      priceCents: 89_000_000,
      priceOnRequest: false,
      beds: 4,
      baths: 3,
      areaM2: 210,
      title_en: `Villa ${RUN}`,
      title_es: `Chalet con piscina ${RUN}`,
      // de has no translation: the fallback text the website shows is what its visitors search.
      title_de: `Villa ${RUN}`,
      description_es: 'Descripción larga',
    });
    expect(doc?.locationIds).toEqual([ids.country, expect.any(String), ids.city]);
    expect(doc?.place_en).toBe(`Docton ${RUN}, North ${RUN}, Readland ${RUN}`);
    // Only these fields: no agency name, contact, commission or media.
    const allowed = new Set([
      'id',
      'kind',
      'ownerAgencyId',
      'developmentId',
      'status',
      'visibility',
      'shareScope',
      'transactionType',
      'propertyTypeId',
      'locationIds',
      'featureIds',
      'priceCents',
      'priceOnRequest',
      'beds',
      'baths',
      'areaM2',
      'plotM2',
      'geo',
      'ref',
      'publishedAt',
      'version',
      'sourceHash',
    ]);
    const extra = Object.keys(doc ?? {}).filter(
      (k) => !allowed.has(k) && !/^(title|place|description)_[a-z]{2}$/.test(k),
    );
    expect(extra).toEqual([]);

    // A share-scope change alone (same document content) still reaches the read model and the index document.
    await update(a, id, { shareScope: 'ALL' });
    await run(await deliver(a));
    expect((await indexDocs([id])).docs[0]?.shareScope).toBe('ALL');
  });

  it('[S5-02] index settings are idempotently applied on boot; the index answers filter, facet and locale text queries', async () => {
    const e = engine();
    const first = await search.ensureListingsIndex(e, indexDef);
    expect(first.created).toBe(true);
    expect(await search.ensureListingsIndex(e, indexDef)).toEqual({ created: false, changed: [] });

    const dev = await as(a, (ctx) =>
      developments.createDevelopment(
        ctx,
        CreateDevelopmentBody.parse({
          ref: code('IX'),
          name: `Index Heights ${RUN}`,
          locationId: ids.city,
          coordinates: { lat: 36.5, lng: -4.9 },
        }),
      ),
    );
    const created = await as(a, (ctx) =>
      developments.createUnits(
        ctx,
        dev.id,
        CreateUnitsBody.parse({
          units: [{ ref: 'IX-1', propertyTypeId: ids.type, bedrooms: 2, priceCents: 31_000_000 }],
        }),
      ),
    );
    const unitId = created.items[0]?.id as string;
    const listingId = await sharedListing(a, {
      bedrooms: 2,
      priceCents: 40_000_000,
      energyRating: 'C',
      energyEmissionsRating: 'C',
    });
    await translate(a, listingId, 'es', `Ático luminoso ${RUN}`);
    await update(a, listingId, { visibility: 'PUBLIC' });
    await run(await deliver(a));

    const { docs: built } = await indexDocs([unitId, listingId]);
    const unit = built.find((d) => d.id === unitId);
    expect(unit).toMatchObject({
      kind: 'UNIT',
      visibility: 'RESTRICTED', // PRIVATE_NETWORK development
      shareScope: 'ALL',
      developmentId: dev.id,
      areaM2: null,
      geo: { lat: 36.5, lng: -4.9 },
    });
    await e.waitForTask(await e.upsert(indexDef.uid, built));

    const mine = { op: 'eq', field: 'ownerAgencyId', value: a.agencyId } as const;
    const text = await e.search(indexDef, {
      text: `luminoso ${RUN}`,
      searchOn: ['title_es'],
      locale: 'es',
      filter: mine,
      limit: 10,
    });
    expect(text.ids).toEqual([listingId]);

    const faceted = await e.search(indexDef, {
      filter: {
        op: 'and',
        filters: [
          mine,
          { op: 'in', field: 'locationIds', values: [ids.country] },
          { op: 'range', field: 'beds', gte: 2 },
        ],
      },
      facets: ['kind', 'visibility', 'propertyTypeId'],
      sort: [{ field: 'priceCents', dir: 'asc' }],
      limit: 10,
    });
    expect(faceted.ids).toEqual([unitId, listingId]);
    expect(faceted.facets.visibility).toEqual({ PUBLIC: 1, RESTRICTED: 1 });
    expect(faceted.facets.propertyTypeId).toEqual({ [ids.type]: 2 });

    const websites = await e.search(indexDef, {
      filter: { op: 'and', filters: [mine, { op: 'eq', field: 'visibility', value: 'PUBLIC' }] },
      limit: 10,
    });
    expect(websites.ids).toEqual([listingId]);
  });
});

describe('search indexer (S5-03)', () => {
  const real = () =>
    createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });
  const uid = `t_sync_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
  const targets: string[] = [];
  type QueueRow = { target_id: string; generation: number; claimed_until: string | null };
  const queueRow = async (id: string) =>
    (
      await rows<QueueRow>(
        sql`select target_id, generation, claimed_until from search_index_queue where target_id = ${id}`,
      )
    )[0];
  /** The index holds exactly what the read models say: each target's sourceHash, none for targets without. */
  async function expectConverged(ids: readonly string[]) {
    const { docs: expected, missing } = await system((tx) => search.indexDocsFor(tx, ids));
    const indexed = await real().fetch(uid, ids, ['id', 'sourceHash']);
    expect(Object.fromEntries(indexed.map((d) => [d.id, d.sourceHash]))).toEqual(
      Object.fromEntries(expected.map((d) => [d.id, d.sourceHash])),
    );
    expect(indexed.filter((d) => missing.includes(String(d.id)))).toEqual([]);
  }
  const listing = async () => {
    const id = await sharedListing(a);
    targets.push(id);
    return id;
  };

  beforeAll(async () => {
    loadStackEnv('test');
    configureSearch(real());
    search.configureSearchIndex({ uid, scope: targets });
    await search.ensureListingsIndex(real(), search.listingsIndex(uid));
  });
  afterAll(async () => {
    await real().dropIndex(uid);
    if (targets.length > 0) {
      await rows(
        sql`delete from search_index_queue where target_id in (${sql.join(
          targets.map((t) => sql`${t}`),
          sql`, `,
        )}) returning target_id`,
      );
    }
  });

  it('[S5-03] a read-model change queues its index push in the same transaction; a rolled-back one queues nothing', async () => {
    const id = await listing();
    await run(await deliver(a));
    const first = await queueRow(id);
    expect(first).toMatchObject({ target_id: id, claimed_until: null });

    // A rebuild that rolls back leaves neither the document nor the queue row changed.
    await update(a, id, { priceCents: 61_000_000 });
    await expect(
      system(async (tx) => {
        await search.rebuildReadModels(tx, 'LISTING', [id]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await queueRow(id))?.generation).toBe(first?.generation);

    // A committed change while queued: a new generation. An unchanged rebuild writes and queues nothing.
    await run(await deliver(a));
    expect((await queueRow(id))?.generation).toBe((first?.generation ?? 0) + 1);
    await build('LISTING', id);
    expect((await queueRow(id))?.generation).toBe((first?.generation ?? 0) + 1);
  });

  it('[S5-03] sync pushes current documents and removals; a target changed during its push stays queued', async () => {
    const kept = await listing();
    const changing = await listing();
    const removed = await listing();
    await run(await deliver(a));
    expect(await search.syncIndex()).toMatchObject({ more: false });
    await expectConverged([kept, changing, removed]);
    expect(await queueRow(kept)).toBeUndefined();

    // A change committed while the push is in flight: the row's generation moves, so the push leaves it queued.
    await update(a, changing, { priceCents: 72_000_000 });
    await update(a, removed, { visibility: 'PRIVATE' });
    const engine = real();
    const racing: SearchEngine = {
      ...engine,
      upsert: async (u, docs) => {
        await update(a, changing, { priceCents: 73_000_000 });
        await run(await deliver(a));
        return engine.upsert(u, docs);
      },
    };
    await run(await deliver(a));
    await search.syncIndex({ engine: racing });
    expect(await queueRow(changing)).toMatchObject({ claimed_until: null });
    expect(await queueRow(removed)).toBeUndefined();
    expect(await real().fetch(uid, [removed], ['id'])).toEqual([]);

    await search.syncIndex();
    expect(await queueRow(changing)).toBeUndefined();
    await expectConverged([kept, changing, removed]);
  });

  it('[S5-03] search down: the sync fails and keeps every change; the next sync converges with none lost', async () => {
    const ids = [await listing(), await listing(), await listing()];
    await run(await deliver(a));
    await search.syncIndex();
    const down = createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 500 });
    // Several rounds of edits while the engine is unreachable, each sync failing.
    for (let round = 0; round < 3; round++) {
      for (const [i, id] of ids.entries()) await update(a, id, { priceCents: 80_000_000 + round * 1_000 + i });
      await run(await deliver(a));
      await expect(search.syncIndex({ engine: down })).rejects.toThrow();
    }
    await update(a, ids[2] as string, { visibility: 'PRIVATE' });
    await run(await deliver(a));
    for (const id of ids) expect(await queueRow(id)).toMatchObject({ claimed_until: null });

    await search.syncIndex();
    for (const id of ids) expect(await queueRow(id)).toBeUndefined();
    await expectConverged(ids);
    expect((await real().fetch(uid, ids, ['priceCents'])).map((d) => d.priceCents).sort()).toEqual([
      80_002_000, 80_002_001,
    ]);
  });

  it('[S5-03] the drift check finds missing, stale and orphan documents; the repair walk queues them and the sync converges', async () => {
    const [gone, stale, fine] = [await listing(), await listing(), await listing()];
    await run(await deliver(a));
    await search.syncIndex();
    expect(await search.checkIndexDrift()).toMatchObject({ drift: false, mismatched: [] });

    const engine = real();
    const orphan = newId();
    const [staleDoc] = (await system((tx) => search.indexDocsFor(tx, [stale]))).docs;
    await engine.waitForTask(await engine.delete(uid, [gone]));
    await engine.waitForTask(
      await engine.upsert(uid, [
        { ...staleDoc, sourceHash: 'stale' },
        { id: orphan, kind: 'LISTING', ownerAgencyId: a.agencyId, sourceHash: 'orphan' },
      ]),
    );

    const report = await search.checkIndexDrift();
    expect(report.drift).toBe(true);
    expect(report.mismatched.sort()).toEqual([gone, stale].sort());
    expect((await queueRow(gone))?.target_id).toBe(gone);

    const repaired = await search.repairIndex({ page: 2 });
    expect(repaired).toMatchObject({ orphans: 1 });
    expect(repaired.targets).toBe(report.targets);
    expect(await queueRow(orphan)).toMatchObject({ target_id: orphan });

    targets.push(orphan); // the scoped sync may take it
    await search.syncIndex();
    expect(await engine.fetch(uid, [orphan], ['id'])).toEqual([]);
    await expectConverged([gone, stale, fine]);
    expect(await search.checkIndexDrift()).toMatchObject({ drift: false, mismatched: [] });
  });

  it('[S5-03] a sync whose lease ran out writes nothing more and never touches rows another sync took over', async () => {
    const id = await listing();
    await run(await deliver(a));
    // Repo level: the first claim's lease expires, a second claim takes the row; the first can neither finish
    // (delete) nor release it.
    const first = await system((tx) => repo.claimIndexSync(tx, 10, 1, [id]));
    expect(first.rows.map((r) => r.targetId)).toEqual([id]);
    await new Promise((r) => setTimeout(r, 20));
    const second = await system((tx) => repo.claimIndexSync(tx, 10, 300_000, [id]));
    expect(second.rows.map((r) => r.targetId)).toEqual([id]);
    expect(await system((tx) => repo.finishIndexSync(tx, first))).toBe(0);
    // still held by the second claim
    expect(await queueRow(id)).toMatchObject({ target_id: id, claimed_until: expect.anything() });
    await system((tx) => repo.releaseIndexSync(tx, second.token));

    // Indexer level: a push stalled until its lease is nearly over stops before its next engine write and gives
    // the rows back.
    const engine = real();
    const deletes: string[][] = [];
    const stalling: SearchEngine = {
      ...engine,
      upsert: async (u, docs) => {
        await new Promise((r) => setTimeout(r, 700));
        return engine.upsert(u, docs);
      },
      delete: async (u, ids) => {
        deletes.push([...ids]);
        return engine.delete(u, ids);
      },
    };
    expect(await search.syncIndex({ engine: stalling, leaseMs: 1_000 })).toMatchObject({ done: 0, more: true });
    expect(deletes).toEqual([]);
    expect(await queueRow(id)).toMatchObject({ claimed_until: null });
    await search.syncIndex();
    expect(await queueRow(id)).toBeUndefined();
    await expectConverged([id]);
  });

  it('[S5-03] a document the engine refuses backs off alone; the rest of its batch is pushed', async () => {
    const ids = [await listing(), await listing(), await listing(), await listing()];
    const bad = ids[2] as string;
    await run(await deliver(a));
    const engine = real();
    const refusing: SearchEngine = {
      ...engine,
      upsert: async (u, docs) => {
        if (docs.some((d) => (d as { id: string }).id === bad)) {
          throw new SearchError('invalid geo', 400, 'invalid_document_geo_field');
        }
        return engine.upsert(u, docs);
      },
    };
    const result = await search.syncIndex({ engine: refusing });
    expect(result.rejected).toEqual([{ targetId: bad, attempts: 1 }]);
    await expectConverged(ids.filter((i) => i !== bad));
    const parked = (
      await rows<{ not_before: string | null; claimed_until: string | null }>(
        sql`select not_before, claimed_until from search_index_queue where target_id = ${bad}`,
      )
    )[0];
    expect(parked?.claimed_until).toBeNull();
    expect(new Date(parked?.not_before ?? 0).getTime()).toBeGreaterThan(Date.now());
    // Backing off: the next sync does not take it (and is not blocked by it).
    expect(await search.syncIndex()).toMatchObject({ done: 0 });
    // A new change of the target ends the backoff.
    await update(a, bad, { priceCents: 66_000_000 });
    await run(await deliver(a));
    expect(await search.syncIndex()).toMatchObject({ rejected: [] });
    await expectConverged(ids);
  });
});
