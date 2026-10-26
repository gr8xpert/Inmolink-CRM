import type { MigrationValidationReport } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffCtx } from '../../../context';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as migration from '../index';

/**
 * Validation reports of the legacy migration (S14-03, PLAN §14 step 6) against fixture staging rows (the real dump is
 * H1): an agency loaded by S14-02 is validated — counts, images, sampled field diffs, URL checks — and staff read the
 * stored report.
 */

const RUN = newId().slice(-8).toLowerCase();
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const lid = (p: string, n: number | string) => `${RUN}-${p}-${n}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('migration.validation.test', fn);
const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'validation int test' }, fn);

let support: string;

/** A legacy agency's staging, every id under prefix `p`. Personal values carry `SECRET` to check they never leak. */
function staging(p: string) {
  const listing = (n: number, extra: object = {}) => ({
    id: lid(p, `l${n}`),
    ref: code(`${p}R${n}`),
    status: 'available',
    listing_type: 'sale',
    price: 250_000 + n,
    bedrooms: 3,
    built_m2: '120.5',
    location_id: lid('tax', 'loc'),
    property_type_id: lid('tax', 'type'),
    feature_ids: [lid('tax', 'pool')],
    images: [`https://img.example.com/${RUN}/${p}/${n}/1.jpg`, `https://img.example.com/${RUN}/${p}/${n}/2.jpg`],
    ...extra,
  });
  return {
    listings: [listing(1), listing(2), listing(3, { location_id: lid('tax', 'nowhere') })],
    contacts: [
      { id: lid(p, 'c1'), first_name: 'SECRETAna', email: `secret-${RUN}-${p}@example.com`, phone: '600 123 456' },
      { id: lid(p, 'c2'), last_name: 'SECRETDup', email: `secret-${RUN}-${p}@example.com` }, // one contact with c1
      { id: lid(p, 'c3'), first_name: 'SECRETBob', phone: 'not a phone' },
    ] as Record<string, unknown>[],
    leads: [
      {
        id: lid(p, 'e1'),
        contact_id: lid(p, 'c1'),
        property_id: lid(p, 'l1'),
        status: 'contacted',
        source: 'web',
        message: 'SECRET message',
      },
      { id: lid(p, 'e2'), contact_id: lid(p, 'c404') }, // contact never staged: not loaded (explained)
    ],
  };
}
type Staging = ReturnType<typeof staging>;
const sources = (st: Staging) =>
  Object.fromEntries(Object.entries(st).map(([k, rows]) => [k, migration.fromRows(rows)])) as Parameters<
    typeof migration.validateLegacyAgency
  >[0]['staged'];
const inventory = (st: Staging) => ({
  listing: st.listings.length,
  contact: st.contacts.length,
  lead: st.leads.length,
  image: st.listings.reduce((n, l) => n + l.images.length, 0),
});

async function loaded(p: string): Promise<{ founder: Founder; st: Staging }> {
  const founder = await createFounder();
  const st = staging(p);
  const result = await migration.migrateLegacyAgency({
    legacyAgencyId: lid(p, 'agency'),
    agencyId: founder.agencyId,
    staged: sources(st),
    requestMedia: async () => undefined,
  });
  expect(result.stoppedAt).toBeNull();
  return { founder, st };
}

const validate = (p: string, founder: Founder, st: Staging, extra: Partial<migration.ValidateLegacyAgencyInput> = {}) =>
  migration.validateLegacyAgency({
    legacyAgencyId: lid(p, 'agency'),
    agencyId: founder.agencyId,
    staged: sources(st),
    legacyRows: inventory(st),
    ...extra,
  });

beforeAll(async () => {
  await setupTestDb('worker');
  support = (await createStaffUser('STAFF_SUPPORT')).userId;
  await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('va'),
      translations: tr(`Validia ${RUN}`, 'validia'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('va-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'va-g'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('va-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'va-villa'),
    });
    const fgroup = await taxonomy.createFeatureGroup(tx, {
      key: code('va-out'),
      sort: 0,
      translations: tr(`Outdoor ${RUN}`, 'va-out'),
    });
    const feature = await taxonomy.createFeature(tx, {
      groupId: fgroup,
      key: code('va-pool'),
      sort: 0,
      icon: 'waves',
      translations: tr(`Pool ${RUN}`, 'va-pool'),
    });
    await migration.recordMaps(tx, 'location', [[lid('tax', 'loc'), location]]);
    await migration.recordMaps(tx, 'propertyType', [[lid('tax', 'type'), type]]);
    await migration.recordMaps(tx, 'feature', [[lid('tax', 'pool'), feature]]);
  });
}, 120_000);

afterAll(async () => {
  await system((tx) =>
    tx.execute(sql`update outbox_events set processed_at = now()
      where processed_at is null and created_at > now() - interval '1 hour' and type like any(array[
        'properties.%', 'crm.%', 'media.feedImages.%'])`),
  );
  await closeDb();
});

const countsOf = (r: MigrationValidationReport, entity: string) => r.counts.find((c) => c.entity === entity);

describe('validation reports (S14-03)', () => {
  it('[S14-03] a loaded agency passes: counts per entity, images, sampled fields and URL checks all accounted for', async () => {
    const { founder, st } = await loaded('a');
    const report = await validate('a', founder, st);
    expect(countsOf(report, 'listing')).toMatchObject({
      legacyRows: 3,
      staged: 3,
      mapped: 2,
      explained: 1,
      unexplained: 0,
      issuesByReason: { unmapped_location: 1 },
    });
    expect(countsOf(report, 'contact')).toMatchObject({ staged: 3, mapped: 3, explained: 0, unexplained: 0 });
    expect(countsOf(report, 'lead')).toMatchObject({ staged: 2, mapped: 1, explained: 1, unexplained: 0 });
    // queued by the load, not downloaded yet (no worker here): pending, not missing
    expect(report.images).toEqual({ legacy: 6, staged: 6, expected: 4, attached: 0, pending: 4, unexplained: 0 });
    expect(report.sample.rows).toBe(6); // 2 listings, 3 contacts, 1 lead
    expect(report.sample.samples.filter((s) => s.outcome !== 'MATCH')).toEqual([]);
    // c2 was taken in by c1's contact (same e-mail): its own values are an explained difference
    expect(report.sample.samples.find((s) => s.legacyId === lid('a', 'c2'))?.explainedFields).toContain('lastName');
    expect(report.urls).toMatchObject({ checked: 2, failed: 0 });
    expect(report.urls.checks.every((c) => c.lookup === 'OK' && c.images.pending === 2)).toBe(true);
    expect(report.totals).toMatchObject({ legacy: 14, unexplained: 0, rate: 0 });
    expect(report.status).toBe('PASS');
  });

  it('[S14-03] reports show ids, counts and field names, never personal values', async () => {
    const { founder, st } = await loaded('p');
    await system((tx) =>
      tx.execute(sql`update contacts c set first_name = 'Changed' from legacy_id_maps m
        where m.entity = 'contact' and m.legacy_id = ${lid('p', 'c3')} and c.id = m.new_id`),
    );
    const report = await validate('p', founder, st);
    expect(report.sample.samples.find((s) => s.legacyId === lid('p', 'c3'))).toMatchObject({
      outcome: 'DIFF',
      fields: ['firstName'],
    });
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/SECRET|Changed|example\.com|img\.example/);
  });

  it('[S14-03] unexplained differences fail: a changed field, a failed download, a row never loaded', async () => {
    const { founder, st } = await loaded('f');
    await system(async (tx) => {
      await tx.execute(sql`update properties p set price_cents = 1 from legacy_id_maps m
        where m.entity = 'listing' and m.legacy_id = ${lid('f', 'l1')} and p.id = m.new_id`);
      // l2's downloads failed: nothing queued, nothing attached
      await tx.execute(sql`delete from feed_image_queue q using legacy_id_maps m
        where m.entity = 'listing' and m.legacy_id = ${lid('f', 'l2')} and q.property_id = m.new_id`);
    });
    // a row staged after the load (never loaded, no reason): unexplained
    const later = { ...st, leads: [...st.leads, { id: lid('f', 'e9'), contact_id: lid('f', 'c1') }] };
    const report = await validate('f', founder, later);
    expect(report.sample.samples.find((s) => s.legacyId === lid('f', 'l1'))?.fields).toEqual(['price']);
    expect(report.sample.samples.find((s) => s.legacyId === lid('f', 'l2'))?.fields).toEqual(['images']);
    expect(report.sample.fields).toEqual(
      expect.arrayContaining([
        { entity: 'listing', field: 'price', compared: 2, differing: 1 },
        { entity: 'listing', field: 'images', compared: 2, differing: 1 },
      ]),
    );
    expect(report.images).toMatchObject({ expected: 4, pending: 2, unexplained: 2 });
    expect(report.urls.checks.find((c) => c.legacyId === lid('f', 'l2'))).toMatchObject({ lookup: 'OK', pass: false });
    expect(countsOf(report, 'lead')).toMatchObject({
      legacyRows: 3,
      staged: 3,
      mapped: 1,
      explained: 1,
      unexplained: 1,
    });
    expect(report.status).toBe('FAIL');
  });

  it('[S14-03] stored reports: the latest per legacy agency, listed with pass / fail and opened by any staff role', async () => {
    const { founder, st } = await loaded('s');
    const failing = await validate('s', founder, { ...st, contacts: [...st.contacts, { id: lid('s', 'c9') }] });
    expect(failing.status).toBe('FAIL');
    const first = await system((tx) => migration.recordValidationReport(tx, failing));
    const passing = await validate('s', founder, st);
    expect(passing.status).toBe('PASS');
    const second = await system((tx) => migration.recordValidationReport(tx, passing));

    const latest = await system(
      async (tx) =>
        (
          await tx.execute<{ id: string; latest: boolean }>(
            sql`select id, latest from migration_validation_reports where legacy_agency_id = ${lid('s', 'agency')}`,
          )
        ).rows,
    );
    expect(latest).toEqual(
      expect.arrayContaining([
        { id: first, latest: false },
        { id: second, latest: true },
      ]),
    );

    const page = await asStaff(support, (ctx) => migration.listValidationReports(ctx, { limit: 100, status: 'PASS' }));
    const row = page.items.find((r) => r.legacyAgencyId === lid('s', 'agency'));
    expect(row).toMatchObject({ id: second, status: 'PASS', agencyId: founder.agencyId, unexplained: 0, rate: 0 });
    expect(page.items.some((r) => r.id === first)).toBe(false);
    const fails = await asStaff(support, (ctx) => migration.listValidationReports(ctx, { limit: 100, status: 'FAIL' }));
    expect(fails.items.some((r) => r.legacyAgencyId === lid('s', 'agency'))).toBe(false);

    const one = await asStaff(support, (ctx) => migration.getValidationReport(ctx, second));
    expect(one.report.counts.map((c) => c.entity)).toEqual([
      'user',
      'listing',
      'development',
      'unit',
      'contact',
      'lead',
    ]);
    expect(one.report.urls.checks).toHaveLength(2);
    const missing = await asStaff(support, (ctx) => migration.getValidationReport(ctx, newId())).catch((e) =>
      isAppError(e) ? e.code : 'thrown',
    );
    expect(missing).toBe('NOT_FOUND');
  });

  it('[S14-review] the hourly delta checkpoints (a failed delta batch, the delta state) do not fail the report', async () => {
    const { founder, st } = await loaded('dl');
    await system(async (tx) => {
      await migration.resolveLegacyAgency(tx, lid('dl', 'agency'), founder.agencyId);
      for (const [entity, seq, status] of [
        ['delta:properties', 0, 'FAILED'],
        ['delta:state', 0, 'DONE'],
      ] as const) {
        await tx.execute(sql`insert into migration_batches
          (id, legacy_agency_id, target_agency_id, entity, seq, input_hash, status, rows, error)
          values (${newId()}, ${lid('dl', 'agency')}, ${founder.agencyId}, ${entity}, ${seq}, ${'0'.repeat(64)},
                  ${status}, 1, ${status === 'FAILED' ? 'code=DB_57014 first=x' : null})`);
      }
    });
    const report = await validate('dl', founder, st);
    expect(report.failedBatches).toEqual([]);
    expect(report.status).toBe('PASS');
  });

  it('[S14-03] an agency whose load stopped at a failed batch fails validation, naming the batch', async () => {
    const founder = await createFounder();
    const st = staging('b');
    await system(async (tx) => {
      await migration.resolveLegacyAgency(tx, lid('b', 'agency'), founder.agencyId);
      await tx.execute(sql`insert into migration_batches
        (id, legacy_agency_id, target_agency_id, entity, seq, input_hash, status, rows, error)
        values (${newId()}, ${lid('b', 'agency')}, ${founder.agencyId}, 'properties', 0, ${'0'.repeat(64)}, 'FAILED', 3,
                'code=DB_23505 first=x')`);
    });
    const report = await validate('b', founder, st);
    expect(report.failedBatches).toEqual([{ entity: 'properties', seq: 0, error: 'code=DB_23505 first=x' }]);
    expect(countsOf(report, 'listing')).toMatchObject({ staged: 3, mapped: 0, unexplained: 3 });
    expect(report.status).toBe('FAIL');
    expect(await system((tx) => migration.agencyOfLegacy(tx, lid('b', 'agency')))).toBe(founder.agencyId);
    expect(await system((tx) => migration.agencyOfLegacy(tx, lid('b', 'nobody')))).toBeNull();
  });
});
