import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as migration from '../index';

/** Legacy transform and load of a whole agency (S14-02) from fixture staging rows (the real dump is H1). */

const RUN = newId().slice(-8).toLowerCase();
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
/** Legacy ids are global in `legacy_id_maps`: unique per run (and per test via `p`). */
const lid = (p: string, n: number | string) => `${RUN}-${p}-${n}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('migration.agency.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const one = async <T>(q: ReturnType<typeof sql>) => (await rows<T>(q))[0] as T;

let ids: { location: string; type: string; feature: string };
const requested: string[] = [];
const requestMedia = async (agencyId: string) => {
  requested.push(agencyId);
};

/** A legacy agency's staging, every id under prefix `p`. */
function staging(p: string, founderEmail: string) {
  const user = (n: number, extra: object = {}) => ({
    id: lid(p, `u${n}`),
    email: `legacy-${RUN}-${p}-${n}@example.com`,
    name: `Agent ${n}`,
    role: 'agent',
    locale: 'es',
    ...extra,
  });
  const listing = (n: number, extra: object = {}) => ({
    id: lid(p, `l${n}`),
    ref: code(`${p}R${n}`),
    agent_id: lid(p, 'u2'),
    status: 'available',
    listing_type: 'sale',
    price: 250_000 + n,
    bedrooms: 3,
    built_m2: '120.5',
    location_id: lid('tax', 'loc'),
    property_type_id: lid('tax', 'type'),
    feature_ids: [lid('tax', 'pool')],
    translations: [{ locale: 'en', title: `Villa ${n}`, description: 'Sea views' }],
    images: [`https://img.example.com/${RUN}/${p}/${n}/1.jpg`, `https://img.example.com/${RUN}/${p}/${n}/2.jpg`],
    ...extra,
  });
  return {
    users: [
      user(1, { role: 'Administrator' }),
      user(2),
      user(3, { active: 0 }), // inactive: not migrated
      user(4, { email: founderEmail }), // already the agency's founder: kept as is
    ],
    listings: [
      listing(1),
      listing(2, { feature_ids: [lid('tax', 'pool'), lid('tax', 'sauna')], agent_id: lid(p, 'u404') }),
      listing(3, { location_id: lid('tax', 'nowhere') }),
      listing(4, { status: 'withdrawn', listing_type: 'rent', price: 1_500 }),
    ],
    developments: [{ id: lid(p, 'd1'), name: 'Residencial', location_id: lid('tax', 'loc'), status: 'off_plan' }],
    units: [{ id: lid(p, 'du1'), development_id: lid(p, 'd1'), property_type_id: lid('tax', 'type'), price: 300_000 }],
    contacts: [
      {
        id: lid(p, 'c1'),
        first_name: 'Ana',
        email: `ana-${RUN}-${p}@example.com`,
        phone: '600 123 456',
        type: 'buyer',
        agent_id: lid(p, 'u2'),
        notes: 'Wants a pool',
        created_at: '2021-05-01T10:00:00Z',
      },
      { id: lid(p, 'c2'), last_name: 'Duplicate', email: `ana-${RUN}-${p}@example.com` }, // same e-mail: one contact
      { id: lid(p, 'c3'), first_name: 'Bob', phone: 'not a phone' },
      { id: lid(p, 'c4') }, // nobody
    ],
    leads: [
      {
        id: lid(p, 'e1'),
        contact_id: lid(p, 'c1'),
        property_id: lid(p, 'l1'),
        agent_id: lid(p, 'u2'),
        status: 'contacted',
        source: 'web',
        message: 'Is it available?',
        created_at: '2022-03-04T05:06:07Z',
      },
      { id: lid(p, 'e2'), contact_id: lid(p, 'c404') }, // contact never staged
      { id: lid(p, 'e3'), contact_id: lid(p, 'c3'), property_id: lid(p, 'du1'), status: 'won' },
    ],
  };
}

/** Staged arrays as sources (the script streams files; tests pass rows). */
function sources(st: ReturnType<typeof staging>): migration.MigrateLegacyAgencyInput['staged'] {
  return Object.fromEntries(Object.entries(st).map(([k, rows]) => [k, migration.fromRows(rows)]));
}

async function newAgency() {
  const founder = await createFounder();
  return founder;
}

function migrate(founder: Founder, p: string, extra: Partial<migration.MigrateLegacyAgencyInput> = {}) {
  return migration.migrateLegacyAgency({
    legacyAgencyId: lid(p, 'agency'),
    agencyId: founder.agencyId,
    staged: sources(staging(p, founder.email)),
    requestMedia,
    ...extra,
  });
}

beforeAll(async () => {
  await setupTestDb('worker');
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('la'),
      translations: tr(`Legacia ${RUN}`, 'legacia'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('la-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'la-g'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('la-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'la-villa'),
    });
    const fgroup = await taxonomy.createFeatureGroup(tx, {
      key: code('la-out'),
      sort: 0,
      translations: tr(`Outdoor ${RUN}`, 'la-out'),
    });
    const feature = await taxonomy.createFeature(tx, {
      groupId: fgroup,
      key: code('la-pool'),
      sort: 0,
      icon: 'waves',
      translations: tr(`Pool ${RUN}`, 'la-pool'),
    });
    await migration.recordMaps(tx, 'location', [[lid('tax', 'loc'), location]]);
    await migration.recordMaps(tx, 'propertyType', [[lid('tax', 'type'), type]]);
    await migration.recordMaps(tx, 'feature', [[lid('tax', 'pool'), feature]]);
    return { location, type, feature };
  });
}, 120_000);

afterAll(async () => {
  await system((tx) =>
    tx.execute(sql`update outbox_events set processed_at = now()
      where processed_at is null and created_at > now() - interval '1 hour' and type like any(array[
        'properties.%', 'developments.%', 'crm.%', 'identity.member.named', 'identity.passwordReset.requested',
        'media.feedImages.%'])`),
  );
  await closeDb();
});

describe('legacy transform and load (S14-02)', () => {
  it('[S14-02] loads users, listings with images, developments, contacts and leads, with maps and a report', async () => {
    const founder = await newAgency();
    const leadEvents0 = await one<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where agency_id = ${founder.agencyId} and type = 'crm.lead.created'`,
    );
    const result = await migrate(founder, 'a', {
      legacyRows: { user: 4, listing: 4, development: 1, unit: 1, contact: 4, lead: 3 },
    });
    const { report } = result;
    expect(result.stoppedAt).toBeNull();
    expect(report.counts.user).toMatchObject({ staged: 4, created: 2, unchanged: 1, failed: 1, mapped: 3 });
    expect(report.counts.listing).toMatchObject({ staged: 4, created: 3, failed: 1, mapped: 3 });
    expect(report.counts.development).toMatchObject({ created: 1, matches: true });
    expect(report.counts.unit).toMatchObject({ created: 1, matches: true });
    expect(report.counts.contact).toMatchObject({ staged: 4, created: 2, unchanged: 1, failed: 1, mapped: 3 });
    expect(report.counts.lead).toMatchObject({ staged: 3, created: 2, failed: 1, mapped: 2 });
    expect(report.matches).toBe(false); // the rows listed below are mismatches
    const issues = report.issues.map((i) => `${i.entity}:${i.legacyId}:${i.reason}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        `user:${lid('a', 'u3')}:invalid`,
        `listing:${lid('a', 'l3')}:unmapped_location`,
        `listing:${lid('a', 'l2')}:unmapped_feature`,
        `contact:${lid('a', 'c4')}:invalid`,
        `contact:${lid('a', 'c3')}:invalid`, // the phone left out (a warning: Bob is loaded)
        `lead:${lid('a', 'e2')}:orphan`,
      ]),
    );

    // Members: no legacy password; e-mail vouched for; the founder kept as is.
    const members = await rows<{ email: string; role: string; verified: boolean }>(
      sql`select m.email, m.role, u.email_verified_at is not null as verified from agency_members m
           join users u on u.id = m.user_id where m.agency_id = ${founder.agencyId} order by m.email`,
    );
    expect(members.filter((m) => m.email.startsWith(`legacy-${RUN}`))).toEqual([
      { email: `legacy-${RUN}-a-1@example.com`, role: 'AGENCY_ADMIN', verified: true },
      { email: `legacy-${RUN}-a-2@example.com`, role: 'AGENT', verified: true },
    ]);
    const [agent] = await rows<{ id: string }>(
      sql`select id from users where email = ${`legacy-${RUN}-a-2@example.com`}`,
    );

    // Listings: legacy reference kept, legacy id, the agent as owner (else the admin), features, images queued.
    const listings = await rows<Record<string, unknown>>(
      sql`select p.ref, p.legacy_id, p.owner_user_id, p.status, p.price_cents::float8 as price, p.source,
                 (select count(*)::int from property_features f where f.property_id = p.id) as features,
                 (select count(*)::int from feed_image_queue q where q.property_id = p.id) as queued
            from properties p where p.agency_id = ${founder.agencyId} order by p.legacy_id`,
    );
    expect(listings).toEqual([
      expect.objectContaining({
        ref: code('aR1'),
        legacy_id: lid('a', 'l1'),
        owner_user_id: agent?.id,
        status: 'ACTIVE',
        price: 25_000_100,
        source: 'LEGACY',
        features: 1,
        queued: 1,
      }),
      expect.objectContaining({ legacy_id: lid('a', 'l2'), owner_user_id: founder.userId, features: 1 }),
      expect.objectContaining({ legacy_id: lid('a', 'l4'), status: 'WITHDRAWN' }),
    ]);
    expect(requested).toContain(founder.agencyId);

    // Contacts: two legacy contacts with one e-mail are one contact; identifiers normalized.
    const contactMaps = await rows<{ legacy_id: string; new_id: string }>(
      sql`select legacy_id, new_id from legacy_id_maps where entity = 'contact'
           and legacy_id = any(${sql.param([lid('a', 'c1'), lid('a', 'c2')])}::text[]) order by legacy_id`,
    );
    expect(contactMaps[0]?.new_id).toBe(contactMaps[1]?.new_id);
    const ana = await one<Record<string, unknown>>(
      sql`select first_name, primary_phone, owner_user_id, created_at::text as created, source from contacts
           where id = ${contactMaps[0]?.new_id}`,
    );
    expect(ana).toMatchObject({
      first_name: 'Ana',
      primary_phone: '+34600123456',
      owner_user_id: agent?.id,
      source: 'IMPORT',
    });
    expect(String(ana.created)).toContain('2021-05-01');

    // Leads: historical (their own time, their status's stage), about the migrated listing / unit, no event.
    const leads = await rows<Record<string, unknown>>(
      sql`select l.status, s.status as stage_status, l.target_kind, l.assigned_user_id, l.created_at::text as created
            from leads l join pipeline_stages s on s.id = l.stage_id
           where l.agency_id = ${founder.agencyId} order by l.created_at`,
    );
    expect(leads).toEqual([
      expect.objectContaining({
        status: 'IN_PROGRESS',
        stage_status: 'IN_PROGRESS',
        target_kind: 'LISTING',
        assigned_user_id: agent?.id,
      }),
      expect.objectContaining({ status: 'WON', stage_status: 'WON', target_kind: 'UNIT' }),
    ]);
    expect(String(leads[0]?.created)).toContain('2022-03-04');
    const leadEvents1 = await one<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where agency_id = ${founder.agencyId} and type = 'crm.lead.created'`,
    );
    expect(leadEvents1.n).toBe(leadEvents0.n);
    // The checklist knows the agency has listings (back-filled after the load).
    const step = await rows(
      sql`select 1 from onboarding_steps where agency_id = ${founder.agencyId} and step = 'IMPORT_LISTINGS'`,
    );
    expect(step).toHaveLength(1);
  });

  it('[S14-02] re-running a batch produces no duplicates (resumed from checkpoints, or run again with --restart)', async () => {
    const founder = await newAgency();
    const counts = () =>
      one<Record<string, number>>(sql`select
        (select count(*)::int from agency_members where agency_id = ${founder.agencyId}) as members,
        (select count(*)::int from properties where agency_id = ${founder.agencyId}) as listings,
        (select count(*)::int from developments where agency_id = ${founder.agencyId}) as developments,
        (select count(*)::int from contacts where agency_id = ${founder.agencyId}) as contacts,
        (select count(*)::int from leads where agency_id = ${founder.agencyId}) as leads,
        (select count(*)::int from legacy_id_maps where legacy_id like ${`${RUN}-b-%`}) as maps`);
    const first = await migrate(founder, 'b');
    const before = await counts();
    expect(before).toMatchObject({ listings: 3, developments: 1, contacts: 2, leads: 2 });

    // Same staging: every batch is DONE with the same rows → skipped, the report rebuilt from the checkpoints.
    const resumed = await migrate(founder, 'b');
    expect(Object.values(resumed.steps).every((s) => s && s.resumed === s.batches)).toBe(true);
    expect(resumed.report.counts).toEqual(first.report.counts);
    expect(await counts()).toEqual(before);

    // Run again for real: everything matches what it became.
    const again = await migrate(founder, 'b', { restart: true });
    expect(again.report.counts.listing).toMatchObject({ created: 0, unchanged: 3 });
    expect(again.report.counts.user).toMatchObject({ created: 0, unchanged: 3 });
    expect(again.report.counts.contact).toMatchObject({ created: 0, unchanged: 3 });
    expect(again.report.counts.lead).toMatchObject({ created: 0, unchanged: 2 });
    expect(again.report.counts.development).toMatchObject({ created: 0, unchanged: 1 });
    expect(await counts()).toEqual(before);
  });

  it('[S14-02] a failed batch stops the run; the re-run resumes from the last checkpoint', async () => {
    const founder = await newAgency();
    const staged = staging('c', founder.email);
    // A location map pointing at nothing: the database refuses that listing's batch.
    await system((tx) => migration.recordMaps(tx, 'location', [[lid('c', 'ghost'), newId()]]));
    staged.listings[1] = { ...staged.listings[1], location_id: lid('c', 'ghost') } as (typeof staged.listings)[number];
    const input = {
      legacyAgencyId: lid('c', 'agency'),
      agencyId: founder.agencyId,
      staged: sources(staged),
      requestMedia,
    };
    const failed = await migration.migrateLegacyAgency({ ...input, batchRows: { listings: 1 } });
    expect(failed.stoppedAt).toMatchObject({ entity: 'properties', seq: 1 });
    // Only the code, the constraint and the batch's first legacy id: never the database's message (it quotes values).
    expect(failed.stoppedAt?.error).toMatch(
      new RegExp(`^code=DB_23503 constraint=[a-z0-9_]+ first=${lid('c', 'l2')}$`),
    );
    expect(failed.steps.properties).toMatchObject({ batches: 2, resumed: 0 }); // streamed: none read after the failure
    expect(failed.report.counts.contact).toMatchObject({ mapped: 0, matches: false }); // never reached
    const checkpoints = () =>
      rows<{ entity: string; seq: number; status: string; attempts: number }>(
        sql`select entity, seq, status, attempts from migration_batches where legacy_agency_id = ${lid('c', 'agency')}
             order by entity, seq`,
      );
    expect((await checkpoints()).filter((c) => c.entity === 'properties')).toEqual([
      { entity: 'properties', seq: 0, status: 'DONE', attempts: 1 },
      { entity: 'properties', seq: 1, status: 'FAILED', attempts: 1 },
    ]);

    // Staff fix the map; the re-run skips batch 0 and resumes at batch 1.
    await system((tx) => migration.recordMaps(tx, 'location', [[lid('c', 'ghost'), ids.location]]));
    const resumed = await migration.migrateLegacyAgency({ ...input, batchRows: { listings: 1 } });
    expect(resumed.stoppedAt).toBeNull();
    expect(resumed.steps.properties).toMatchObject({ batches: 4, resumed: 1 });
    expect(resumed.report.counts.listing).toMatchObject({ created: 3, mapped: 3 });
    expect(resumed.report.counts.lead).toMatchObject({ created: 2 });
    expect((await checkpoints()).filter((c) => c.entity === 'properties')).toEqual([
      { entity: 'properties', seq: 0, status: 'DONE', attempts: 1 },
      { entity: 'properties', seq: 1, status: 'DONE', attempts: 2 },
      { entity: 'properties', seq: 2, status: 'DONE', attempts: 1 },
      { entity: 'properties', seq: 3, status: 'DONE', attempts: 1 },
    ]);
    const listings = await one<{ n: number }>(
      sql`select count(*)::int as n from properties where agency_id = ${founder.agencyId}`,
    );
    expect(listings.n).toBe(3);
  });

  it('[S14-02] a dry run checks everything and writes nothing', async () => {
    const founder = await newAgency();
    const result = await migrate(founder, 'd', { dryRun: true });
    expect(result.report.dryRun).toBe(true);
    expect(result.report.counts.user).toMatchObject({ created: 2 });
    expect(result.report.counts.contact).toMatchObject({ created: 2 });
    const left = await one<Record<string, number>>(sql`select
      (select count(*)::int from agency_members where agency_id = ${founder.agencyId}) as members,
      (select count(*)::int from contacts where agency_id = ${founder.agencyId}) as contacts,
      (select count(*)::int from migration_batches where legacy_agency_id = ${lid('d', 'agency')}) as checkpoints,
      (select count(*)::int from legacy_id_maps where legacy_id like ${`${RUN}-d-%`}) as maps`);
    expect(left).toEqual({ members: 1, contacts: 0, checkpoints: 0, maps: 0 });
  });

  it('[S14-02] migrated members sign in through a password reset, sent only when asked', async () => {
    const founder = await newAgency();
    const resets = () =>
      one<{ n: number }>(sql`select count(*)::int as n from outbox_events o
        where o.type = 'identity.passwordReset.requested' and o.payload->>'userId' in (
          select u.id::text from users u where u.email like ${`legacy-${RUN}-e-%`})`);
    await migrate(founder, 'e');
    expect((await resets()).n).toBe(0);
    const result = await migrate(founder, 'e', { sendPasswordResets: true });
    // the two migrated members and the founder (a legacy user too)
    expect(result.passwordResets).toBe(3);
    expect((await resets()).n).toBe(2);
  });

  it('[S14-02] a listing batch is a fixed number of statements, whatever its size', async () => {
    const founder = await newAgency();
    const batch = (p: string, n: number) => {
      const s = staging(p, founder.email);
      return {
        ...s,
        listings: Array.from({ length: n }, (_, i) => ({
          ...s.listings[0],
          id: lid(p, `n${i}`),
          ref: code(`${p}N${i}`),
        })),
      };
    };
    const count = (p: string, n: number) =>
      countQueries(() =>
        migration.migrateLegacyAgency({
          legacyAgencyId: lid(p, 'agency'),
          agencyId: founder.agencyId,
          staged: { listings: migration.fromRows(batch(p, n).listings) },
          dryRun: true,
          requestMedia,
        }),
      );
    await count('h', 1); // warms the agency settings cache (the default commission is read once, then cached)
    const small = await count('f', 2);
    const big = await count('g', 60);
    expect(big).toBe(small);
  });

  it('[S14-02] a v2 agency is the target of one legacy agency only', async () => {
    const founder = await newAgency();
    expect(await system((tx) => migration.resolveLegacyAgency(tx, lid('o', 'agency1'), founder.agencyId))).toBe(
      founder.agencyId,
    );
    await expect(
      system((tx) => migration.resolveLegacyAgency(tx, lid('o', 'agency2'), founder.agencyId)),
    ).rejects.toThrow(/already the target of another legacy agency/);
    // the first legacy agency still finds it
    expect(await system((tx) => migration.resolveLegacyAgency(tx, lid('o', 'agency1')))).toBe(founder.agencyId);
  });

  it('[S14-02] maps are per agency: a legacy id another agency loaded is refused, never re-pointed or followed', async () => {
    const a = await newAgency();
    const b = await newAgency();
    const shared = { id: lid('s', 'c1'), first_name: 'Shared', email: `shared-${RUN}@example.com` };
    await migration.migrateLegacyAgency({
      legacyAgencyId: lid('s', 'agencyA'),
      agencyId: a.agencyId,
      staged: { contacts: migration.fromRows([shared]) },
      requestMedia,
    });
    const before = await one<{ new_id: string; target_agency_id: string }>(
      sql`select new_id, target_agency_id from legacy_id_maps where entity = 'contact' and legacy_id = ${shared.id}`,
    );
    expect(before.target_agency_id).toBe(a.agencyId);

    const result = await migration.migrateLegacyAgency({
      legacyAgencyId: lid('s', 'agencyB'),
      agencyId: b.agencyId,
      staged: {
        users: migration.fromRows([{ id: lid('s', 'u1'), email: a.email, name: 'Taken' }]),
        contacts: migration.fromRows([{ ...shared, email: `other-${RUN}@example.com` }]),
        leads: migration.fromRows([{ id: lid('s', 'e1'), contact_id: shared.id }]),
      },
      requestMedia,
    });
    const issues = result.report.issues.map((i) => `${i.entity}:${i.legacyId}:${i.reason}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        `user:${lid('s', 'u1')}:email_taken`, // a member of agency A: for staff to settle before cutover
        `contact:${shared.id}:legacy_id_collision`,
        `lead:${lid('s', 'e1')}:orphan`, // agency A's contact is never linked
      ]),
    );
    expect(result.report.counts.contact).toMatchObject({ created: 0, failed: 1, matches: false });
    const after = await one<{ new_id: string; target_agency_id: string }>(
      sql`select new_id, target_agency_id from legacy_id_maps where entity = 'contact' and legacy_id = ${shared.id}`,
    );
    expect(after).toEqual(before);
    const bContacts = await one<{ n: number }>(
      sql`select count(*)::int as n from contacts where agency_id = ${b.agencyId}`,
    );
    expect(bContacts.n).toBe(0);
  });
});
