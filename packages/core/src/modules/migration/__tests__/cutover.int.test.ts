import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as migration from '../index';

/**
 * Per-agency cutover checklists (S14-06) against fixture legacy snapshots (the legacy database is H1; the staging
 * rehearsal with real agencies and DNS is H11 / H4).
 */

const RUN = newId().slice(-8).toLowerCase();
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const lid = (p: string, n: number | string) => `${RUN}-${p}-${n}`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('migration.cutover.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const requestMedia = async () => {};
let locationId = '';

type Legacy = Record<migration.LegacyStagingEntity, Record<string, unknown>[]>;

function legacy(p: string): Legacy {
  return {
    users: [1, 2].map((n) => ({
      id: lid(p, `u${n}`),
      email: `cutover-${RUN}-${p}-${n}@example.com`,
      name: `Agent ${n}`,
      role: 'agent',
    })),
    listings: [1, 2, 3].map((n) => ({
      id: lid(p, `l${n}`),
      ref: code(`${p}R${n}`),
      agent_id: lid(p, 'u1'),
      status: 'available',
      listing_type: 'sale',
      price: 300_000 + n,
      bedrooms: 3,
      location_id: lid('tax', 'loc'),
      property_type_id: lid('tax', 'type'),
      translations: [{ locale: 'en', title: `Villa ${n}`, description: 'Sea views' }],
    })),
    developments: [],
    units: [],
    contacts: [],
    leads: [],
  };
}

/** A frozen legacy snapshot (the final delta reads it); counts how often it was opened. */
function opener(db: Legacy) {
  const opened = { n: 0, closed: 0 };
  const open = async (): Promise<migration.OpenedLegacyDeltaSource> => {
    opened.n += 1;
    return {
      snapshotAt: new Date(),
      changed: (entity) => migration.fromRows(db[entity]),
      async *listingIds() {
        yield db.listings.map((l) => l.id as string);
      },
      close: async () => {
        opened.closed += 1;
      },
    };
  };
  return { open, opened };
}

/** The legacy freeze control (H1) as a fake: records every call. */
function control() {
  const calls: [string, boolean][] = [];
  const c: migration.LegacyControl = {
    setReadOnly: async (id, readOnly) => {
      calls.push([id, readOnly]);
    },
  };
  return { c, calls };
}

async function loaded(p: string): Promise<{ founder: Founder; db: Legacy; legacyAgencyId: string }> {
  const founder = await createFounder();
  const db = legacy(p);
  const legacyAgencyId = lid(p, 'agency');
  await system((tx) => migration.resolveLegacyAgency(tx, legacyAgencyId, founder.agencyId));
  const result = await migration.migrateLegacyAgency({
    legacyAgencyId,
    agencyId: founder.agencyId,
    staged: Object.fromEntries(Object.entries(db).map(([k, r]) => [k, migration.fromRows(r)])),
    requestMedia,
  });
  expect(result.stoppedAt).toBeNull();
  return { founder, db, legacyAgencyId };
}

/** Records a validation report as the legacy agency's latest (what `pnpm legacy:validate` writes). */
const report = (legacyAgencyId: string, agencyId: string, status: 'PASS' | 'FAIL') =>
  system(async (tx) => {
    await tx.execute(sql`update migration_validation_reports set latest = false
                          where legacy_agency_id = ${legacyAgencyId} and latest`);
    await tx.execute(sql`insert into migration_validation_reports
      (id, legacy_agency_id, target_agency_id, status, latest, legacy_rows, unexplained, sample_diffs, url_failures,
       report, created_at, updated_at)
      values (${newId()}, ${legacyAgencyId}, ${agencyId}, ${status}, true, 5, ${status === 'PASS' ? 0 : 3}, 0, 0,
              '{}'::jsonb, ${new Date()}, ${new Date()})`);
  });

const resets = async (agencyId: string) =>
  (
    await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events e
      where e.type = 'identity.passwordReset.requested'
        and (e.payload->>'userId')::uuid in (select new_id from legacy_id_maps
                                               where entity = 'user' and target_agency_id = ${agencyId})`)
  )[0]?.n ?? 0;

const notices = async (agencyId: string) =>
  (
    await rows<{ n: number }>(
      sql`select count(*)::int as n from notifications where agency_id = ${agencyId} and type = 'MIGRATION_CUT_OVER'`,
    )
  )[0]?.n ?? 0;

const audits = async (cutoverId: string) =>
  rows<{ type: string; step: string | null }>(
    sql`select type, metadata->>'step' as step from audit_logs where target_id = ${cutoverId} order by occurred_at, id`,
  );

beforeAll(async () => {
  await setupTestDb('worker');
  await system(async (tx) => {
    locationId = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('co'),
      translations: tr(`Cutoverland ${RUN}`, 'cutoverland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('co-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'co-g'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('co-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'co-villa'),
    });
    await migration.recordMaps(tx, 'location', [[lid('tax', 'loc'), locationId]]);
    await migration.recordMaps(tx, 'propertyType', [[lid('tax', 'type'), type]]);
  });
}, 120_000);

afterEach(() => migration.registerLegacyControl(null));

afterAll(async () => {
  await system((tx) =>
    tx.execute(sql`update outbox_events set processed_at = now()
      where processed_at is null and created_at > now() - interval '1 hour' and type like any(array[
        'properties.%', 'crm.%', 'identity.%', 'media.feedImages.%', 'notifications.%'])`),
  );
  await closeDb();
});

describe('cutover checklist (S14-06)', () => {
  it('[S14-06] Path A: cutover of a test agency completes every step, audited, resumable at a gate, < 30 min', async () => {
    const l = await loaded('a');
    const agencyId = l.founder.agencyId;
    const src = opener(l.db);
    const plan = await migration.planCutover({ agencyId, path: 'A', legacyAgencyId: l.legacyAgencyId });
    expect(plan).toMatchObject({ state: 'PLANNED', path: 'A', inventoryMode: null });

    // No legacy control (H1) and no confirmation: the run stops before touching anything.
    const r0 = await migration.runCutover({ agencyId, openSource: src.open, requestMedia });
    expect(r0).toMatchObject({ state: 'IN_PROGRESS', stoppedAt: 'FREEZE', reason: 'CONFIRM_FREEZE', steps: [] });
    expect(src.opened.n).toBe(0);

    // Legacy control registered; the latest report FAILs: the run stops at the validation gate.
    const ctl = control();
    migration.registerLegacyControl(ctl.c);
    await report(l.legacyAgencyId, agencyId, 'FAIL');
    const r1 = await migration.runCutover({ agencyId, openSource: src.open, requestMedia });
    expect(r1).toMatchObject({ stoppedAt: 'VALIDATE', reason: 'VALIDATION_FAILED', steps: ['FREEZE', 'FINAL_DELTA'] });
    expect(ctl.calls).toEqual([[l.legacyAgencyId, true]]);
    expect(src.opened).toEqual({ n: 1, closed: 1 });
    expect((await migration.getCutover(agencyId))?.lastError).toBe('VALIDATE:VALIDATION_FAILED');
    expect((await migration.legacyDeltaState(l.legacyAgencyId)).cutOverAt).toBeNull();

    // `legacy:validate` PASSes after the final delta: the next run resumes at the gate and finishes.
    await report(l.legacyAgencyId, agencyId, 'PASS');
    const r2 = await migration.runCutover({ agencyId, openSource: src.open, requestMedia });
    expect(r2).toMatchObject({
      state: 'CUT_OVER',
      stoppedAt: null,
      steps: ['VALIDATE', 'STOP_DELTA', 'ENABLE_ACCESS', 'NOTIFY'],
    });
    expect(r0.elapsedMs + r1.elapsedMs + r2.elapsedMs).toBeLessThan(migration.CUTOVER.TARGET_MS);
    expect(src.opened.n).toBe(1); // the final delta is not run again
    expect(ctl.calls).toHaveLength(1);
    expect((await migration.legacyDeltaState(l.legacyAgencyId)).cutOverAt).not.toBeNull();
    expect(await resets(agencyId)).toBe(2); // both migrated members get their way in
    expect(await notices(agencyId)).toBe(1); // the founder (admin) is told

    const c = await migration.getCutover(agencyId);
    expect(c).toMatchObject({ state: 'CUT_OVER', lastError: null, leaseUntil: null });
    expect(c?.steps.ENABLE_ACCESS).toMatchObject({ status: 'DONE', sent: 2 });
    expect(c?.steps.FREEZE).toMatchObject({ status: 'DONE', mode: 'AUTOMATIC' });
    const log = await audits(c?.id as string);
    expect(log.map((a) => a.type)).toEqual([
      'migration.cutover.planned',
      ...Array(6).fill('migration.cutover.stepDone'),
      'migration.cutover.completed',
    ]);
    expect(log.filter((a) => a.step).map((a) => a.step)).toEqual(migration.CUTOVER_STEPS.A);

    // Idempotent: a repeated run changes nothing and mails nobody again.
    const again = await migration.runCutover({ agencyId, openSource: src.open, requestMedia });
    expect(again).toMatchObject({ state: 'CUT_OVER', steps: [], stoppedAt: null });
    expect(await resets(agencyId)).toBe(2);
    expect(await notices(agencyId)).toBe(1);
    // A cut-over checklist is not re-planned.
    await expect(
      migration.planCutover({ agencyId, path: 'A', legacyAgencyId: l.legacyAgencyId }),
    ).rejects.toMatchObject({ code: 'RUNNING_OR_DONE' });
  });

  it('[S14-06] Path A: rollback of a test agency re-opens the delta and unfreezes legacy, audited, < 30 min', async () => {
    const l = await loaded('b');
    const agencyId = l.founder.agencyId;
    const src = opener(l.db);
    const ctl = control();
    migration.registerLegacyControl(ctl.c);
    await migration.planCutover({ agencyId, path: 'A', legacyAgencyId: l.legacyAgencyId });
    expect((await migration.runCutover({ agencyId, openSource: src.open, requestMedia })).reason).toBe(
      'NO_VALIDATION_REPORT',
    );
    await report(l.legacyAgencyId, agencyId, 'PASS');
    expect((await migration.runCutover({ agencyId, openSource: src.open, requestMedia })).state).toBe('CUT_OVER');

    const rb = await migration.rollbackCutover({ agencyId });
    expect(rb).toMatchObject({
      state: 'ROLLED_BACK',
      stoppedAt: null,
      steps: ['NOTIFY', 'STOP_DELTA', 'VALIDATE', 'FINAL_DELTA', 'FREEZE'],
    });
    expect(rb.elapsedMs).toBeLessThan(migration.CUTOVER.TARGET_MS);
    expect(ctl.calls).toEqual([
      [l.legacyAgencyId, true],
      [l.legacyAgencyId, false],
    ]);
    expect((await migration.legacyDeltaState(l.legacyAgencyId)).cutOverAt).toBeNull();
    const c = await migration.getCutover(agencyId);
    expect(c).toMatchObject({ state: 'ROLLED_BACK', cutOverAt: null });
    expect(c?.steps.ENABLE_ACCESS?.status).toBe('DONE'); // the sent e-mails stay sent
    const log = await audits(c?.id as string);
    expect(log.filter((a) => a.type === 'migration.cutover.stepRolledBack')).toHaveLength(5);
    expect(log.at(-1)?.type).toBe('migration.cutover.rolledBack');
    // A repeated rollback does nothing.
    expect(await migration.rollbackCutover({ agencyId })).toMatchObject({ state: 'ROLLED_BACK', steps: [] });

    // The next cutover re-runs the final delta and needs a report newer than it; members are not mailed twice.
    const r = await migration.runCutover({ agencyId, openSource: src.open, requestMedia });
    expect(r).toMatchObject({ stoppedAt: 'VALIDATE', reason: 'VALIDATION_STALE' });
    expect(src.opened.n).toBe(2);
    await report(l.legacyAgencyId, agencyId, 'PASS');
    expect(await migration.runCutover({ agencyId, openSource: src.open, requestMedia })).toMatchObject({
      state: 'CUT_OVER',
      steps: ['VALIDATE', 'STOP_DELTA', 'NOTIFY'],
    });
    expect(await resets(agencyId)).toBe(2);
    expect(await notices(agencyId)).toBe(2);
  });

  it('[S14-06] a manual freeze is confirmed by the operator; so is its rollback; runs never interleave', async () => {
    const l = await loaded('c');
    const agencyId = l.founder.agencyId;
    const src = opener(l.db);
    const c = await migration.planCutover({ agencyId, path: 'A', legacyAgencyId: l.legacyAgencyId });

    // Another run holds the lease: refused.
    await system((tx) =>
      tx.execute(sql`update migration_cutovers set lease_owner = ${newId()}, lease_until = now() + interval '5 minutes'
                      where id = ${c.id}`),
    );
    await expect(migration.runCutover({ agencyId, confirm: ['FREEZE'] })).rejects.toMatchObject({ code: 'BUSY' });
    // Its lease expired (the run crashed): the next run takes over.
    await system((tx) =>
      tx.execute(sql`update migration_cutovers set lease_until = now() - interval '1 second' where id = ${c.id}`),
    );
    await report(l.legacyAgencyId, agencyId, 'FAIL');
    const r = await migration.runCutover({ agencyId, confirm: ['FREEZE'], openSource: src.open, requestMedia });
    expect(r).toMatchObject({ steps: ['FREEZE', 'FINAL_DELTA'], reason: 'VALIDATION_FAILED' });
    expect((await migration.getCutover(agencyId))?.steps.FREEZE).toMatchObject({ mode: 'MANUAL' });

    // Rolling back a manual freeze waits for the operator's confirmation, then completes.
    const stopped = await migration.rollbackCutover({ agencyId });
    expect(stopped).toMatchObject({ stoppedAt: 'FREEZE', reason: 'CONFIRM_UNFREEZE', steps: ['FINAL_DELTA'] });
    expect(await migration.rollbackCutover({ agencyId, confirm: ['FREEZE'] })).toMatchObject({
      state: 'ROLLED_BACK',
      steps: ['FREEZE'],
    });
    await expect(migration.runCutover({ agencyId: newId() })).rejects.toMatchObject({ code: 'NOT_PLANNED' });
  });

  it('[S14-06] Path B: renewal-date tracking, parity gate, website feed switch and its rollback', async () => {
    const founder = await createFounder();
    const agencyId = founder.agencyId;
    const plan = await migration.planCutover({
      agencyId,
      path: 'B',
      provider: 'resales-online',
      renewalDate: '2027-03-15',
      areaLocationIds: [locationId],
      oldAreaListings: 1_000_000,
    });
    // Scheduled just before the old provider renews: nobody pays twice.
    expect(plan).toMatchObject({ scheduledFor: '2027-03-08', inventoryMode: 'PARALLEL', state: 'PLANNED' });
    const due = await migration.dueCutovers({ days: 30, now: new Date('2027-02-20T00:00:00Z') });
    expect(due.map((d) => d.targetAgencyId)).toContain(agencyId);
    const early = await migration.dueCutovers({ days: 7, now: new Date('2027-02-20T00:00:00Z') });
    expect(early.map((d) => d.targetAgencyId)).not.toContain(agencyId);

    // The v2 network in the area is far from the old provider's count: the gate holds.
    const r1 = await migration.runCutover({ agencyId });
    expect(r1).toMatchObject({ stoppedAt: 'PARITY', reason: 'PARITY_NOT_REACHED' });
    expect((await migration.areaParity(agencyId)).reached).toBe(false);

    // The operator's count is updated during the parallel run: parity, then the managed site's switch is confirmed.
    await migration.planCutover({
      agencyId,
      path: 'B',
      provider: 'resales-online',
      renewalDate: '2027-03-15',
      areaLocationIds: [locationId],
      oldAreaListings: 0,
    });
    const r2 = await migration.runCutover({ agencyId });
    expect(r2).toMatchObject({ steps: ['PARITY'], stoppedAt: 'SWITCH_FEED', reason: 'CONFIRM_SWITCH_FEED' });
    const r3 = await migration.runCutover({ agencyId, confirm: ['SWITCH_FEED'] });
    expect(r3).toMatchObject({ state: 'CUT_OVER', steps: ['SWITCH_FEED', 'NOTIFY'] });
    expect(r1.elapsedMs + r2.elapsedMs + r3.elapsedMs).toBeLessThan(migration.CUTOVER.TARGET_MS);
    expect(await migration.getCutover(agencyId)).toMatchObject({ inventoryMode: 'V2', state: 'CUT_OVER' });
    expect(await notices(agencyId)).toBe(1);

    // Rollback: the site goes back to both inventories once the operator switched it back.
    expect(await migration.rollbackCutover({ agencyId })).toMatchObject({ reason: 'CONFIRM_SWITCH_BACK' });
    const rb = await migration.rollbackCutover({ agencyId, confirm: ['SWITCH_FEED'] });
    expect(rb).toMatchObject({ state: 'ROLLED_BACK', steps: ['SWITCH_FEED', 'PARITY'] });
    expect(await migration.getCutover(agencyId)).toMatchObject({ inventoryMode: 'PARALLEL' });
  });

  it('[S14-review] ENABLE_ACCESS mails each created v2 user once: not twice for two legacy users, never a matched member', async () => {
    const founder = await createFounder();
    const db = legacy('t');
    const legacyAgencyId = lid('t', 'agency');
    db.users.push(
      // a second legacy user with u1's e-mail: one v2 user
      { id: lid('t', 'u3'), email: `cutover-${RUN}-t-1@example.com`, name: 'Twin', role: 'agent' },
      // the agency's founder, matched by e-mail: already has its way in
      { id: lid('t', 'u4'), email: founder.email, name: 'Founder', role: 'admin' },
    );
    await system((tx) => migration.resolveLegacyAgency(tx, legacyAgencyId, founder.agencyId));
    const load = await migration.migrateLegacyAgency({
      legacyAgencyId,
      agencyId: founder.agencyId,
      staged: Object.fromEntries(Object.entries(db).map(([k, r]) => [k, migration.fromRows(r)])),
      requestMedia,
    });
    expect(load.stoppedAt).toBeNull();
    const perUser = async () =>
      rows<{ userId: string; n: number }>(sql`select payload->>'userId' as "userId", count(*)::int as n
        from outbox_events where type = 'identity.passwordReset.requested'
         and (payload->>'userId')::uuid in (select new_id from legacy_id_maps
                                             where entity = 'user' and target_agency_id = ${founder.agencyId})
       group by 1 order by 1`);
    expect(await perUser()).toEqual([]); // the load mailed nobody

    migration.registerLegacyControl(control().c);
    await migration.planCutover({ agencyId: founder.agencyId, path: 'A', legacyAgencyId });
    const src = opener(db);
    await migration.runCutover({ agencyId: founder.agencyId, openSource: src.open, requestMedia });
    await report(legacyAgencyId, founder.agencyId, 'PASS');
    const done = await migration.runCutover({ agencyId: founder.agencyId, openSource: src.open, requestMedia });
    expect(done).toMatchObject({ state: 'CUT_OVER', stoppedAt: null });
    const mailed = await perUser();
    expect(mailed).toHaveLength(2); // u1 (= u3) and u2
    expect(mailed.every((m) => m.n === 1)).toBe(true);
    expect(mailed.map((m) => m.userId)).not.toContain(founder.userId);
    expect((await migration.getCutover(founder.agencyId))?.steps.ENABLE_ACCESS).toMatchObject({
      status: 'DONE',
      sent: 2,
    });
  });

  it('[S14-06] DNS readiness lists migrated legacy agencies without a PASS report', async () => {
    const l = await loaded('d');
    const ids = async () => (await migration.legacyDnsReadiness(100_000)).notReady.map((a) => a.legacyAgencyId);
    expect(await ids()).toContain(l.legacyAgencyId);
    await report(l.legacyAgencyId, l.founder.agencyId, 'PASS');
    expect(await ids()).not.toContain(l.legacyAgencyId);
    await expect(
      migration.planCutover({ agencyId: newId(), path: 'A', legacyAgencyId: l.legacyAgencyId }),
    ).rejects.toMatchObject({ code: 'LEGACY_AGENCY_MISMATCH' });
  });
});
