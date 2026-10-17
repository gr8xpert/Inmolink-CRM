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
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
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

/** Runs queued jobs (a recheck they queue in turn is only recorded). */
async function run(jobs: Queued[]): Promise<void> {
  const enqueue = vi.spyOn(search.searchJobs.buildReadModel, 'enqueue').mockResolvedValue({ id: 'test' });
  try {
    for (const { job, payload } of jobs) {
      const def = search.searchJobs[job as keyof typeof search.searchJobs];
      await def.spec.run(def.spec.payload.parse(payload) as never, jobCtx());
    }
  } finally {
    enqueue.mockRestore();
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
          version: latest - 2,
          card: older,
          detail: current?.detail as never,
          etag: etagOf(older, current?.detail),
        },
      ]),
    );
    expect(written).toBe(0);
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
    expect(single).toBeLessThanOrEqual(10);
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
