import { CreateDevelopmentBody, CreateUnitsBody, PutListingOverrideBody } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as developments from '../../developments';
import * as taxonomy from '../../taxonomy';
import * as properties from '../index';

/** Listing overrides on the real database (S3-10): an agency's own text, used only in its own channels. */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

type Member = { userId: string; agencyId: string };
let owner: Founder;
let presenter: Founder;
let stranger: Founder;
let ids: { location: string; type: string };

const as = <T>(m: Member, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('properties.overrides.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const log = createLogger({ service: 'test', level: 'silent' });
const jobCtx = () => ({
  log,
  jobId: 'test',
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});
const overridesOf = (targetId: string) =>
  rows<{ agency_id: string }>(sql`select agency_id from listing_overrides where target_id = ${targetId}`);

/** The dispatcher's part (S5-F2): the event's `properties.removeOverrides` job, as the subscription queues it. */
async function runRemoveJob(type: string, field: string, targetKind: Kind, targetId: string): Promise<void> {
  const [e] = await rows<{ id: string; agency_id: string }>(
    sql`select id, agency_id from outbox_events where type = ${type} and payload->>${field} = ${targetId}`,
  );
  if (!e) throw new Error(`no ${type} event`);
  await properties.propertiesJobs.removeOverrides.spec.run(
    { eventId: e.id, agencyId: e.agency_id, targetKind, targetId },
    jobCtx(),
  );
}

const overrideEvents = (targetId: string) =>
  rows<{ payload: Record<string, unknown> }>(
    sql`select payload from outbox_events
        where type = 'properties.listingOverride.changed' and payload->>'targetId' = ${targetId} order by id`,
  );

type Kind = 'LISTING' | 'DEVELOPMENT' | 'UNIT';
const save = (m: Member, kind: Kind, id: string, body: Record<string, unknown>, locale = 'en') =>
  as(m, (ctx) => properties.saveListingOverride(ctx, kind, id, locale, PutListingOverrideBody.parse(body)));
const textOf = (m: Member, listingId: string) =>
  as(m, (ctx) => properties.listingTexts(ctx, [listingId], 'en')).then((t) => t.get(listingId));

/** A shared, active listing of `m` with its English text. */
async function seedListing(m: Member, ref: string): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`
    insert into properties (id, agency_id, owner_user_id, ref, status, visibility, transaction_type, price_cents,
                            bedrooms, built_m2, energy_rating, property_type_id, location_id)
    values (gen_random_uuid(), ${m.agencyId}, ${m.userId}, ${code(ref)}, 'ACTIVE', 'SHARED', 'SALE', 35000000, 3,
            120.5, 'C', ${ids.type}, ${ids.location})
    returning id`);
  const id = (row as { id: string }).id;
  await rows(sql`insert into property_translations (property_id, agency_id, locale, title, description, slug)
    values (${id}, ${m.agencyId}, 'en', 'Owner villa', 'Owner description', ${code('owner-villa')})`);
  return id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  [owner, presenter, stranger] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const f of [owner, presenter, stranger]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('ov'),
      translations: tr(`Overrideland ${RUN}`, 'overrideland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('ov-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'ov-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('ov-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'ov-villa'),
    });
    return { location, type };
  });
}, 120_000);

afterAll(closeDb);

describe('listing overrides', () => {
  it("[S3-10] an override is used only in the overriding agency's channels", async () => {
    const listing = await seedListing(owner, 'OV1');
    const owned = { title: 'Owner villa', description: 'Owner description' };

    // The presenter rewrites the title only: its channels show its title over the owner's description.
    const saved = await save(presenter, 'LISTING', listing, { title: 'Sea-view villa, our pick', description: '' });
    expect(saved).toMatchObject({ targetKind: 'LISTING', locale: 'en', title: 'Sea-view villa, our pick' });
    expect(saved).toMatchObject({ description: null, origin: 'HUMAN' });
    expect(await textOf(presenter, listing)).toEqual({
      title: 'Sea-view villa, our pick',
      description: owned.description,
    });

    // The owner and any other agency keep the owner's text, and never see the override itself.
    expect(await textOf(owner, listing)).toEqual(owned);
    expect(await textOf(stranger, listing)).toEqual(owned);
    const card = [{ id: listing, ...owned }];
    expect(await as(stranger, (ctx) => properties.applyListingOverrides(ctx, 'LISTING', 'en', card))).toEqual(card);
    expect(await as(owner, (ctx) => properties.listListingOverrides(ctx, 'LISTING', listing))).toEqual({ items: [] });
    expect(await rows(sql`select 1 from listing_overrides where target_id = ${listing}`)).toHaveLength(1);
    // Other locales are untouched.
    expect(await as(presenter, (ctx) => properties.applyListingOverrides(ctx, 'LISTING', 'es', card))).toEqual(card);

    // Only what the agency may present, and never its own listings (it edits those).
    expect(await refusal(save(owner, 'LISTING', listing, { title: 'Mine' }))).toBe('LISTING_OVERRIDE_OWN_TARGET');
    const hidden = await seedListing(owner, 'OV2');
    await rows(sql`update properties set visibility = 'PRIVATE' where id = ${hidden}`);
    expect(await refusal(save(presenter, 'LISTING', hidden, { title: 'Nope' }))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(save(presenter, 'LISTING', listing, { title: 'Hola' }, 'xx'))).toBe('VALIDATION_FAILED');

    // New builds: a development shared with the presenter, and its units.
    const dev = await as(owner, (ctx) =>
      developments.createDevelopment(
        ctx,
        CreateDevelopmentBody.parse({ ref: code('DOV'), name: 'Marbella Heights', locationId: ids.location }),
      ),
    );
    await as(owner, (ctx) =>
      developments.setDevelopmentAccess(ctx, dev.id, {
        version: dev.version,
        kind: 'PRIVATE_NETWORK',
        allowedAgencyIds: [presenter.agencyId],
      }),
    );
    const [unit] = (
      await as(owner, (ctx) =>
        developments.createUnits(
          ctx,
          dev.id,
          CreateUnitsBody.parse({ units: [{ ref: 'A1', propertyTypeId: ids.type, priceCents: 40000000 }] }),
        ),
      )
    ).items;
    const unitId = (unit as { id: string }).id;
    await save(presenter, 'DEVELOPMENT', dev.id, { description: 'Our take on Marbella Heights' });
    await save(presenter, 'UNIT', unitId, { title: 'Corner flat A1' });
    const devCard = [{ id: dev.id, title: 'Marbella Heights', description: 'Developer text' }];
    expect(await as(presenter, (ctx) => properties.applyListingOverrides(ctx, 'DEVELOPMENT', 'en', devCard))).toEqual([
      { id: dev.id, title: 'Marbella Heights', description: 'Our take on Marbella Heights' },
    ]);
    expect(await as(owner, (ctx) => properties.applyListingOverrides(ctx, 'DEVELOPMENT', 'en', devCard))).toEqual(
      devCard,
    );
    const unitCard = [{ id: unitId, title: 'A1', description: null }];
    expect(await as(presenter, (ctx) => properties.applyListingOverrides(ctx, 'UNIT', 'en', unitCard))).toEqual([
      { id: unitId, title: 'Corner flat A1', description: null },
    ]);
    // A development not shared with the agency cannot be overridden; nor can the owner's own.
    expect(await refusal(save(stranger, 'DEVELOPMENT', dev.id, { title: 'x' }))).toBe('DEVELOPMENT_NOT_FOUND');
    expect(await refusal(save(stranger, 'UNIT', unitId, { title: 'x' }))).toBe('UNIT_NOT_FOUND');
    expect(await refusal(save(owner, 'UNIT', unitId, { title: 'x' }))).toBe('LISTING_OVERRIDE_OWN_TARGET');

    // Every change is an event, for the agency's channels to refresh; an unchanged save writes nothing.
    await save(presenter, 'LISTING', listing, { title: 'Sea-view villa, our pick' });
    expect((await overrideEvents(listing)).map((e) => e.payload)).toEqual([
      { agencyId: presenter.agencyId, targetKind: 'LISTING', targetId: listing, locale: 'en' },
    ]);

    // One statement whatever the number of cards.
    const many = Array.from({ length: 50 }, () => ({ id: newId(), title: 't', description: null }));
    expect(
      await countQueries(() =>
        as(presenter, (ctx) => properties.applyListingOverrides(ctx, 'LISTING', 'en', [...many, ...card])),
      ),
    ).toBeLessThanOrEqual(4); // the statement + the member context's own set-up
  });

  it('[S3-10] removing the override falls back to the owner text', async () => {
    const listing = await seedListing(owner, 'OV3');
    await save(presenter, 'LISTING', listing, { title: 'Our title', description: 'Our description' });
    expect(await textOf(presenter, listing)).toEqual({ title: 'Our title', description: 'Our description' });
    const listed = await as(presenter, (ctx) => properties.listListingOverrides(ctx, 'LISTING', listing));
    expect(listed.items.map((o) => o.locale)).toEqual(['en']);

    await as(presenter, (ctx) => properties.deleteListingOverride(ctx, 'LISTING', listing, 'en'));
    expect(await textOf(presenter, listing)).toEqual({ title: 'Owner villa', description: 'Owner description' });
    expect(await as(presenter, (ctx) => properties.listListingOverrides(ctx, 'LISTING', listing))).toEqual({
      items: [],
    });
    expect(await refusal(as(presenter, (ctx) => properties.deleteListingOverride(ctx, 'LISTING', listing, 'en')))).toBe(
      'LISTING_OVERRIDE_NOT_FOUND',
    );
    expect(await overrideEvents(listing)).toHaveLength(2);
  });

  it("[S5-F2] a purged listing's overrides are removed; so are a deleted unit's and a deleted development's", async () => {
    const [purged, kept] = [await seedListing(owner, 'OV4'), await seedListing(owner, 'OV5')];
    for (const l of [purged, kept]) {
      await save(presenter, 'LISTING', l, { title: 'Ours' });
      await save(presenter, 'LISTING', l, { title: 'Nuestro' }, 'es');
    }
    await rows(sql`update properties set deleted_at = now() - interval '31 days' where id = ${purged}`);
    await system((tx) => properties.purgeListings(tx, [purged]));
    await runRemoveJob('properties.listing.purged', 'listingId', 'LISTING', purged);
    expect(await overridesOf(purged)).toEqual([]);
    expect(await overridesOf(kept)).toHaveLength(2);

    // New builds: a deleted unit's overrides go; a deleted development's go with its remaining units'.
    const dev = await as(owner, (ctx) =>
      developments.createDevelopment(
        ctx,
        CreateDevelopmentBody.parse({ ref: code('DOV2'), name: 'Purge Heights', locationId: ids.location }),
      ),
    );
    const shared = await as(owner, (ctx) =>
      developments.setDevelopmentAccess(ctx, dev.id, {
        version: dev.version,
        kind: 'PRIVATE_NETWORK',
        allowedAgencyIds: [presenter.agencyId],
      }),
    );
    const created = await as(owner, (ctx) =>
      developments.createUnits(
        ctx,
        dev.id,
        CreateUnitsBody.parse({
          units: ['B1', 'B2'].map((ref) => ({ ref, propertyTypeId: ids.type, priceCents: 40000000 })),
        }),
      ),
    );
    const [b1, b2] = ['B1', 'B2'].map((ref) => created.items.find((u) => u.ref === ref)?.id) as [string, string];
    await save(presenter, 'DEVELOPMENT', dev.id, { title: 'Our heights' });
    for (const u of [b1, b2]) await save(presenter, 'UNIT', u, { title: 'Our unit' });

    await as(owner, (ctx) => developments.deleteUnit(ctx, dev.id, b1));
    await runRemoveJob('developments.unit.deleted', 'unitId', 'UNIT', b1);
    expect(await overridesOf(b1)).toEqual([]);
    expect(await overridesOf(b2)).toHaveLength(1);

    await as(owner, (ctx) => developments.deleteDevelopment(ctx, dev.id, shared.version));
    await runRemoveJob('developments.development.deleted', 'developmentId', 'DEVELOPMENT', dev.id);
    expect(await overridesOf(dev.id)).toEqual([]);
    expect(await overridesOf(b2)).toEqual([]);
    // A second run (a duplicate delivery) finds nothing.
    await runRemoveJob('developments.development.deleted', 'developmentId', 'DEVELOPMENT', dev.id);
  });

  it('[S6-F1] removeOverrides for a live target, or one of another agency, removes nothing', async () => {
    /** The job as a forged or misrouted event would queue it: any target, any agency. */
    const job = (agencyId: string, targetKind: Kind, targetId: string) =>
      properties.propertiesJobs.removeOverrides.spec.run(
        { eventId: newId(), agencyId, targetKind, targetId },
        jobCtx(),
      ) as Promise<{ removed: number; kept?: boolean }>;

    // Listings: a live one, and a soft-deleted one (restorable; not purged) keep every agency's overrides.
    const [live, deleted] = [await seedListing(owner, 'OV6'), await seedListing(owner, 'OV7')];
    for (const l of [live, deleted]) await save(presenter, 'LISTING', l, { title: 'Ours' });
    await rows(sql`update properties set deleted_at = now() where id = ${deleted}`);
    for (const agencyId of [owner.agencyId, stranger.agencyId]) {
      expect(await job(agencyId, 'LISTING', live)).toEqual({ removed: 0, kept: true });
      expect(await job(agencyId, 'LISTING', deleted)).toEqual({ removed: 0, kept: true });
    }
    expect(await overridesOf(live)).toHaveLength(1);
    expect(await overridesOf(deleted)).toHaveLength(1);

    // New builds: a live development and unit keep theirs, for any agency.
    const dev = await as(owner, (ctx) =>
      developments.createDevelopment(
        ctx,
        CreateDevelopmentBody.parse({ ref: code('DOV3'), name: 'Kept Heights', locationId: ids.location }),
      ),
    );
    await as(owner, (ctx) =>
      developments.setDevelopmentAccess(ctx, dev.id, {
        version: dev.version,
        kind: 'PRIVATE_NETWORK',
        allowedAgencyIds: [presenter.agencyId],
      }),
    );
    const created = await as(owner, (ctx) =>
      developments.createUnits(
        ctx,
        dev.id,
        CreateUnitsBody.parse({ units: [{ ref: 'C1', propertyTypeId: ids.type, priceCents: 40000000 }] }),
      ),
    );
    const unit = created.items[0]?.id as string;
    await save(presenter, 'DEVELOPMENT', dev.id, { title: 'Our heights' });
    await save(presenter, 'UNIT', unit, { title: 'Our unit' });
    for (const agencyId of [owner.agencyId, stranger.agencyId]) {
      expect(await job(agencyId, 'DEVELOPMENT', dev.id)).toEqual({ removed: 0, kept: true });
      expect(await job(agencyId, 'UNIT', unit)).toEqual({ removed: 0, kept: true });
    }

    // Deleted (soft) by its owner: another agency's job still removes nothing; the owner's removes them all.
    await as(owner, async (ctx) =>
      developments.deleteDevelopment(ctx, dev.id, (await developments.getDevelopment(ctx, dev.id)).version),
    );
    expect(await job(stranger.agencyId, 'DEVELOPMENT', dev.id)).toEqual({ removed: 0, kept: true });
    expect(await job(presenter.agencyId, 'DEVELOPMENT', dev.id)).toEqual({ removed: 0, kept: true });
    expect(await overridesOf(dev.id)).toHaveLength(1);
    expect(await overridesOf(unit)).toHaveLength(1);
    expect(await job(owner.agencyId, 'DEVELOPMENT', dev.id)).toEqual({ removed: 2, kept: false });
    expect(await overridesOf(dev.id)).toEqual([]);
    expect(await overridesOf(unit)).toEqual([]);
  });
});
