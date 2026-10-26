/**
 * Cutover checklist queries (S14-06, PLAN §14 Path A step 7 / Path B). Queries only `@inmolink/db/schema/migration`:
 * the checklists (`migration_cutovers`), the migrated members' maps (`legacy_id_maps`) and the latest validation reports.
 * Operator data, `withSystem()` only (the cutover script).
 */
import type { Tx } from '@inmolink/db';
import { legacyIdMaps, migrationCutovers, migrationValidationReports } from '@inmolink/db/schema/migration';
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';

export type CutoverPath = 'A' | 'B';
export type CutoverState = 'PLANNED' | 'IN_PROGRESS' | 'CUT_OVER' | 'ROLLED_BACK';
export type InventoryMode = 'PARALLEL' | 'V2';

/** One step's record in `steps` (`status` and time, plus the step's own counts / cursor / mode). */
export type StepRecord = { status: 'DONE' | 'RUNNING' | 'ROLLED_BACK'; at: string } & Record<
  string,
  string | number | boolean | null
>;

export interface CutoverRow {
  id: string;
  targetAgencyId: string;
  path: CutoverPath;
  legacyAgencyId: string | null;
  provider: string | null;
  renewalDate: string | null;
  scheduledFor: string | null;
  state: CutoverState;
  steps: Record<string, StepRecord>;
  inventoryMode: InventoryMode | null;
  areaLocationIds: string[];
  oldAreaListings: number | null;
  lastError: string | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  startedAt: Date | null;
  cutOverAt: Date | null;
  rolledBackAt: Date | null;
  createdAt: Date;
}

const cols = {
  id: migrationCutovers.id,
  targetAgencyId: migrationCutovers.targetAgencyId,
  path: migrationCutovers.path,
  legacyAgencyId: migrationCutovers.legacyAgencyId,
  provider: migrationCutovers.provider,
  renewalDate: migrationCutovers.renewalDate,
  scheduledFor: migrationCutovers.scheduledFor,
  state: migrationCutovers.state,
  steps: migrationCutovers.steps,
  inventoryMode: migrationCutovers.inventoryMode,
  areaLocationIds: migrationCutovers.areaLocationIds,
  oldAreaListings: migrationCutovers.oldAreaListings,
  lastError: migrationCutovers.lastError,
  leaseOwner: migrationCutovers.leaseOwner,
  leaseUntil: migrationCutovers.leaseUntil,
  startedAt: migrationCutovers.startedAt,
  cutOverAt: migrationCutovers.cutOverAt,
  rolledBackAt: migrationCutovers.rolledBackAt,
  createdAt: migrationCutovers.createdAt,
};

/** The agency's checklist (`migration_cutovers_agency_uq`). */
export async function cutoverOf(tx: Tx, agencyId: string): Promise<CutoverRow | null> {
  const [row] = await tx.select(cols).from(migrationCutovers).where(eq(migrationCutovers.targetAgencyId, agencyId));
  return (row as CutoverRow | undefined) ?? null;
}

export interface CutoverPlan {
  id: string;
  targetAgencyId: string;
  path: CutoverPath;
  legacyAgencyId: string | null;
  provider: string | null;
  renewalDate: string | null;
  scheduledFor: string | null;
  inventoryMode: InventoryMode | null;
  areaLocationIds: string[];
  oldAreaListings: number | null;
}

/**
 * Records the plan, or updates it (dates, provider, parity area and count) until the agency is cut over — not while a
 * run holds the lease, and not the path of a started checklist. Answers the row, or null when it was left as it is.
 */
export async function upsertPlan(tx: Tx, plan: CutoverPlan, now: Date): Promise<CutoverRow | null> {
  const [row] = await tx
    .insert(migrationCutovers)
    .values({ ...plan, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: migrationCutovers.targetAgencyId,
      set: {
        path: sql`excluded.path`,
        legacyAgencyId: sql`excluded.legacy_agency_id`,
        provider: sql`excluded.provider`,
        renewalDate: sql`excluded.renewal_date`,
        scheduledFor: sql`excluded.scheduled_for`,
        inventoryMode: sql`coalesce(${migrationCutovers.inventoryMode}, excluded.inventory_mode)`,
        areaLocationIds: sql`excluded.area_location_ids`,
        oldAreaListings: sql`excluded.old_area_listings`,
        updatedAt: now,
      },
      // Not once cut over, not while a run holds the lease, never a path change mid-run.
      setWhere: sql`${migrationCutovers.state} <> 'CUT_OVER'
        and (${migrationCutovers.leaseUntil} is null or ${migrationCutovers.leaseUntil} < ${now})
        and (${migrationCutovers.state} <> 'IN_PROGRESS' or ${migrationCutovers.path} = excluded.path)`,
    })
    .returning(cols);
  return (row as CutoverRow | undefined) ?? null;
}

/**
 * Takes the run lease (free, expired, or already this run's). Answers the row, or null when another run holds it.
 * One statement: two runs of one agency never both get it.
 */
export async function claimLease(
  tx: Tx,
  agencyId: string,
  runId: string,
  now: Date,
  until: Date,
): Promise<CutoverRow | null> {
  const t = migrationCutovers;
  const [row] = await tx
    .update(t)
    .set({ leaseOwner: runId, leaseUntil: until, updatedAt: now })
    .where(
      and(eq(t.targetAgencyId, agencyId), or(isNull(t.leaseUntil), lt(t.leaseUntil, now), eq(t.leaseOwner, runId))),
    )
    .returning(cols);
  return (row as CutoverRow | undefined) ?? null;
}

export async function releaseLease(tx: Tx, id: string, runId: string): Promise<void> {
  await tx
    .update(migrationCutovers)
    .set({ leaseOwner: null, leaseUntil: null, updatedAt: sql`now()` })
    .where(and(eq(migrationCutovers.id, id), eq(migrationCutovers.leaseOwner, runId)));
}

/**
 * Records one step (merged into `steps`) and any of the checklist's own fields, only while this run holds the lease.
 * Answers whether it was recorded.
 */
export async function recordStep(
  tx: Tx,
  id: string,
  runId: string,
  step: string,
  record: StepRecord,
  fields: Partial<{
    state: CutoverState;
    inventoryMode: InventoryMode | null;
    startedAt: Date;
    cutOverAt: Date | null;
    rolledBackAt: Date | null;
  }> = {},
): Promise<boolean> {
  const rows = await tx
    .update(migrationCutovers)
    .set({
      ...fields,
      steps: sql`${migrationCutovers.steps} || jsonb_build_object(${step}::text, ${JSON.stringify(record)}::jsonb)`,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(migrationCutovers.id, id), eq(migrationCutovers.leaseOwner, runId)))
    .returning({ id: migrationCutovers.id });
  return rows.length > 0;
}

/** Sets the checklist's state and times (lease held). */
export async function setState(
  tx: Tx,
  id: string,
  runId: string,
  fields: Partial<{ state: CutoverState; startedAt: Date; cutOverAt: Date | null; rolledBackAt: Date | null }>,
): Promise<void> {
  await tx
    .update(migrationCutovers)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(and(eq(migrationCutovers.id, id), eq(migrationCutovers.leaseOwner, runId)));
}

/** Why the run stopped (a code, no data). */
export async function setLastError(tx: Tx, id: string, code: string): Promise<void> {
  await tx
    .update(migrationCutovers)
    .set({ lastError: code.slice(0, 200), updatedAt: sql`now()` })
    .where(eq(migrationCutovers.id, id));
}

/** Open checklists scheduled up to `until` (null schedule last), keyset by (scheduled_for, id) (`…_due_idx`). */
export async function dueCutovers(tx: Tx, until: string, limit: number): Promise<CutoverRow[]> {
  const t = migrationCutovers;
  return (await tx
    .select(cols)
    .from(t)
    .where(and(inArray(t.state, ['PLANNED', 'IN_PROGRESS', 'ROLLED_BACK']), lte(t.scheduledFor, until)))
    .orderBy(asc(t.scheduledFor), asc(t.id))
    .limit(limit)) as CutoverRow[];
}

/**
 * The v2 users the legacy users of this agency became, after `after` in legacy id order (`legacy_id_maps_legacy_uq`
 * range on entity `user`, filtered by agency). The member's way in is a password reset (S14-02).
 */
export async function migratedUsersPage(
  tx: Tx,
  agencyId: string,
  after: string | null,
  limit: number,
): Promise<{ legacyId: string; userId: string }[]> {
  const m = legacyIdMaps;
  return tx
    .select({ legacyId: m.legacyId, userId: m.newId })
    .from(m)
    .where(
      and(eq(m.entity, 'user'), eq(m.targetAgencyId, agencyId), after === null ? undefined : gt(m.legacyId, after)),
    )
    .orderBy(asc(m.legacyId))
    .limit(limit);
}

/** A legacy agency's latest validation report: status and time (`migration_validation_reports_latest_uq`). */
export async function latestReport(
  tx: Tx,
  legacyAgencyId: string,
): Promise<{ id: string; status: 'PASS' | 'FAIL'; targetAgencyId: string; createdAt: Date } | null> {
  const r = migrationValidationReports;
  const [row] = await tx
    .select({ id: r.id, status: r.status, targetAgencyId: r.targetAgencyId, createdAt: r.createdAt })
    .from(r)
    .where(and(eq(r.legacyAgencyId, legacyAgencyId), eq(r.latest, true)));
  return (row as { id: string; status: 'PASS' | 'FAIL'; targetAgencyId: string; createdAt: Date } | undefined) ?? null;
}

/**
 * DNS readiness of the legacy API hostname (all legacy sites at once): migrated legacy agencies (their `agency` maps)
 * whose latest validation report is missing or not PASS, after `after` in legacy id order. One statement.
 */
export async function notReadyPage(
  tx: Tx,
  after: string | null,
  limit: number,
): Promise<{ legacyAgencyId: string; agencyId: string; status: 'PASS' | 'FAIL' | null }[]> {
  const m = legacyIdMaps;
  const r = migrationValidationReports;
  return (await tx
    .select({ legacyAgencyId: m.legacyId, agencyId: m.newId, status: r.status })
    .from(m)
    .leftJoin(r, and(eq(r.legacyAgencyId, m.legacyId), eq(r.latest, true)))
    .where(
      and(
        eq(m.entity, 'agency'),
        after === null ? undefined : gt(m.legacyId, after),
        sql`(${r.status} is null or ${r.status} <> 'PASS')`,
      ),
    )
    .orderBy(asc(m.legacyId))
    .limit(limit)) as { legacyAgencyId: string; agencyId: string; status: 'PASS' | 'FAIL' | null }[];
}

/** Migrated legacy agencies in total (the `agency` maps) and those cut over (their checklist CUT_OVER). */
export async function cutoverTotals(tx: Tx): Promise<{ agencies: number; cutOver: number }> {
  const [row] = (
    await tx.execute(sql`
      select (select count(*)::int from ${legacyIdMaps} where ${legacyIdMaps.entity} = 'agency') as agencies,
             (select count(*)::int from ${migrationCutovers}
               where ${migrationCutovers.path} = 'A' and ${migrationCutovers.state} = 'CUT_OVER') as cut_over`)
  ).rows as { agencies: number; cut_over: number }[];
  return { agencies: row?.agencies ?? 0, cutOver: row?.cut_over ?? 0 };
}
