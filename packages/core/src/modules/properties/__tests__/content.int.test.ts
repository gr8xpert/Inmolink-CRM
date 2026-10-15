import {
  CreateListingBody,
  type ListingDto,
  PutListingTranslationBody,
  SetListingFeaturesBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as properties from '../index';

/** Listing content use cases for the editor (S3-05): translations, features, field locks. */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

type Member = { userId: string; agencyId: string };
let owner: Founder;
let agent: Member;
let reader: Founder;
let ids: { location: string; type: string; pool: string; seaView: string };

const as = <T>(m: Member, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string; details?: { field?: string } }) =>
      err.details?.field ? `${err.code}:${err.details.field}` : (err.code ?? String(err)),
  );
const create = (m: Member, body: Partial<CreateListingBody> = {}) =>
  as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location, ...body }),
    ),
  );
const update = (m: Member, l: Pick<ListingDto, 'id'>, version: number, body: Partial<UpdateListingBody>) =>
  as(m, (ctx) => properties.updateListing(ctx, l.id, UpdateListingBody.parse({ version, ...body })));
const translate = (m: Member, id: string, locale: string, body: Record<string, unknown>) =>
  as(m, (ctx) => properties.saveListingTranslation(ctx, id, locale, PutListingTranslationBody.parse(body)));
const setFeatures = (m: Member, id: string, version: number, featureIds: string[]) =>
  as(m, (ctx) => properties.setListingFeatures(ctx, id, SetListingFeaturesBody.parse({ version, featureIds })));

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('properties.content.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const updatedEvents = (listingId: string) =>
  rows<{ changed: string[] }>(
    sql`select payload->'changed' as changed from outbox_events
        where type = 'properties.listing.updated' and payload->>'listingId' = ${listingId} order by id`,
  ).then((r) => r.map((e) => e.changed));

beforeAll(async () => {
  await setupTestDb('worker');
  [owner, reader] = await Promise.all([createFounder(), createFounder()]);
  for (const f of [owner, reader]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  const agentId = newId();
  await system(async (tx) => {
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
      code: code('cc'),
      translations: tr(`Contentland ${RUN}`, 'contentland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('c-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'c-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('c-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'c-villa'),
    });
    const fgroup = await taxonomy.createFeatureGroup(tx, {
      key: code('c-outdoor'),
      sort: 0,
      translations: tr(`Outdoor ${RUN}`, 'c-outdoor'),
    });
    const pool = await taxonomy.createFeature(tx, {
      groupId: fgroup,
      key: code('c-pool'),
      sort: 0,
      icon: 'waves',
      translations: tr(`Pool ${RUN}`, 'c-pool'),
    });
    const seaView = await taxonomy.createFeature(tx, {
      groupId: fgroup,
      key: code('c-sea'),
      sort: 1,
      icon: 'eye',
      translations: tr(`Sea view ${RUN}`, 'c-sea'),
    });
    return { location, type, pool, seaView };
  });
}, 120_000);

afterAll(closeDb);

describe('listing content', () => {
  it('[S3-05] create → add translations → publish SHARED → appears in own list and in the network', async () => {
    const l = await create(owner);
    const es = await translate(owner, l.id, 'es', {
      version: l.version,
      title: 'Villa con vistas al mar en Marbella',
      description: 'Una villa luminosa.',
    });
    expect(es.translations).toMatchObject([
      { locale: 'es', slug: 'villa-con-vistas-al-mar-en-marbella', origin: 'HUMAN', locked: false },
    ]);
    const en = await translate(owner, l.id, 'en', { version: es.version, title: 'Sea-view villa', locked: true });
    expect(en.version).toBe(es.version + 1);
    expect(en.translations.map((t) => [t.locale, t.origin, t.locked])).toEqual([
      ['en', 'HUMAN', true],
      ['es', 'HUMAN', false],
    ]);

    const shared = await update(owner, l, en.version, { status: 'ACTIVE', visibility: 'SHARED' });
    expect(shared).toMatchObject({ status: 'ACTIVE', visibility: 'SHARED' });
    const own = await as(owner, (ctx) => properties.listListings(ctx, { limit: 100 }));
    expect(own.items.find((i) => i.id === l.id)).toMatchObject({ visibility: 'SHARED', status: 'ACTIVE' });
    // Another verified agency reads the shared listing's texts (network view, RLS of S3-01).
    const network = await as(reader, (ctx) => properties.getListingContent(ctx, l.id));
    expect(network.translations.map((t) => t.locale)).toEqual(['en', 'es']);
  });

  it('[S3-05] field lock toggles persist and come back with the listing', async () => {
    const l = await create(owner);
    const locked = await update(owner, l, l.version, { lockedFields: ['price', 'coordinates'] });
    expect(locked.private?.lockedFields).toEqual(['price', 'coordinates']);
    const read = await as(owner, (ctx) => properties.getListing(ctx, l.id));
    expect(read.private?.lockedFields).toEqual(['price', 'coordinates']);
    const unlocked = await update(owner, l, read.version, { lockedFields: ['coordinates'] });
    expect((await as(owner, (ctx) => properties.getListing(ctx, l.id))).private?.lockedFields).toEqual(['coordinates']);
    expect(unlocked.version).toBe(read.version + 1);
  });

  it('[S3-05] editing an AI draft makes it REVIEWED; an unchanged save writes nothing', async () => {
    const l = await create(owner);
    await system((tx) =>
      tx.execute(sql`insert into property_translations (property_id, agency_id, locale, title, slug, origin)
        values (${l.id}, ${owner.agencyId}, 'de', 'Villa mit Meerblick', 'villa-mit-meerblick', 'AI_DRAFT')`),
    );
    const reviewed = await translate(owner, l.id, 'de', { version: l.version, title: 'Villa mit Meerblick!' });
    expect(reviewed.translations[0]).toMatchObject({ origin: 'REVIEWED', slug: 'villa-mit-meerblick' });
    const again = await translate(owner, l.id, 'de', {
      version: reviewed.version,
      title: 'Villa mit Meerblick!',
      slug: 'villa-mit-meerblick',
    });
    expect(again.version).toBe(reviewed.version);
    expect(await updatedEvents(l.id)).toEqual([['translations']]);
  });

  it('[S3-05] a stale version is VERSION_CONFLICT; an unsupported locale is VALIDATION_FAILED', async () => {
    const l = await create(owner);
    const first = await translate(owner, l.id, 'es', { version: l.version, title: 'Uno' });
    expect(await refusal(translate(owner, l.id, 'es', { version: l.version, title: 'Dos' }))).toBe('VERSION_CONFLICT');
    expect(await refusal(translate(owner, l.id, 'it', { version: first.version, title: 'Uno' }))).toBe(
      'VALIDATION_FAILED:locale',
    );
  });

  it('[S3-05] removing a translation drops it and bumps the version', async () => {
    const l = await create(owner);
    const saved = await translate(owner, l.id, 'fr', { version: l.version, title: 'Villa' });
    const removed = await as(owner, (ctx) => properties.deleteListingTranslation(ctx, l.id, 'fr', saved.version));
    expect(removed).toMatchObject({ translations: [], version: saved.version + 1 });
  });

  it('[S3-05] features are replaced as a set; an unknown feature is a validation error', async () => {
    const l = await create(owner);
    const one = await setFeatures(owner, l.id, l.version, [ids.pool, ids.seaView]);
    expect(one.featureIds).toEqual([ids.pool, ids.seaView].sort());
    const two = await setFeatures(owner, l.id, one.version, [ids.seaView]);
    expect(two).toMatchObject({ featureIds: [ids.seaView], version: one.version + 1 });
    const same = await setFeatures(owner, l.id, two.version, [ids.seaView]);
    expect(same.version).toBe(two.version);
    expect(await refusal(setFeatures(owner, l.id, two.version, [newId()]))).toBe('VALIDATION_FAILED:featureIds');
    expect(await updatedEvents(l.id)).toEqual([['features'], ['features']]);
  });

  it("[S3-05] only the owner agency writes content; agents only their own listings'", async () => {
    const l = await create(owner);
    expect(await refusal(translate(agent, l.id, 'es', { version: l.version, title: 'X' }))).toBe('FORBIDDEN');
    expect(await refusal(setFeatures(reader, l.id, l.version, [ids.pool]))).toBe('LISTING_NOT_FOUND');
    const mine = await create(agent);
    expect((await translate(agent, mine.id, 'es', { version: mine.version, title: 'Mío' })).version).toBe(
      mine.version + 1,
    );
  });

  it('[S3-05] dashboard budget: content read and a translation save stay within 10 queries', async () => {
    const l = await create(owner);
    const read = await countQueries(() => as(owner, (ctx) => properties.getListingContent(ctx, l.id)));
    const write = await countQueries(() => translate(owner, l.id, 'es', { version: l.version, title: 'Budget' }));
    expect(read).toBeLessThanOrEqual(10);
    expect(write).toBeLessThanOrEqual(10);
  });
});
