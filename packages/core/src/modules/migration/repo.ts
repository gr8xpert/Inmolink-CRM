/**
 * migration queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/migration` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import { legacyIdMaps, migrationBatches } from '@inmolink/db/schema/migration';
import { newId } from '@inmolink/platform/ids';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';

export type MapEntity = 'location' | 'propertyType' | 'feature';
/**
 * Every entity a legacy id may name: taxonomy (S2-06), the agency a legacy agency became and, from the legacy
 * migration (S4-04, S14), developments, units, listings and the rest.
 */
export type LegacyEntity = MapEntity | 'agency' | 'user' | 'listing' | 'development' | 'unit' | 'contact' | 'lead';
export type IdMapRow = {
  id: string;
  legacyId: string;
  newId: string;
  method: string;
  /** The agency the mapped row belongs to (tenant entities, S14-02); null/absent for platform data. */
  targetAgencyId?: string | null;
};

/** Current maps of the given legacy IDs of one entity (one statement per chunk). */
export async function getMaps(
  tx: Tx,
  entity: LegacyEntity,
  legacyIds: readonly string[],
): Promise<Map<string, { newId: string; method: string; targetAgencyId: string | null }>> {
  const out = new Map<string, { newId: string; method: string; targetAgencyId: string | null }>();
  for (let i = 0; i < legacyIds.length; i += 1000) {
    const rows = await tx
      .select({
        legacyId: legacyIdMaps.legacyId,
        newId: legacyIdMaps.newId,
        method: legacyIdMaps.method,
        targetAgencyId: legacyIdMaps.targetAgencyId,
      })
      .from(legacyIdMaps)
      .where(and(eq(legacyIdMaps.entity, entity), inArray(legacyIdMaps.legacyId, legacyIds.slice(i, i + 1000))));
    for (const r of rows) out.set(r.legacyId, { newId: r.newId, method: r.method, targetAgencyId: r.targetAgencyId });
  }
  return out;
}

/**
 * Idempotent: a re-run with the same pair changes nothing visible; a moved target is replaced. A staff-set
 * map (`method = 'manual'`) is never overwritten, nor a map of another agency's row (S14-02: the target agency must
 * be the same, null for platform data).
 */
export async function upsertMaps(tx: Tx, entity: LegacyEntity, rows: readonly IdMapRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    await tx
      .insert(legacyIdMaps)
      .values(rows.slice(i, i + 1000).map((r) => ({ ...r, targetAgencyId: r.targetAgencyId ?? null, entity })))
      .onConflictDoUpdate({
        target: [legacyIdMaps.entity, legacyIdMaps.legacyId],
        set: { newId: sql`excluded.new_id`, method: sql`excluded.method`, updatedAt: sql`now()` },
        setWhere: sql`${legacyIdMaps.method} <> 'manual'
          and ${legacyIdMaps.targetAgencyId} is not distinct from excluded.target_agency_id`,
      });
  }
}

/** The legacy ids mapped to this v2 id (`legacy_id_maps_new_idx`), at most `limit`. */
export async function legacyIdsOf(tx: Tx, entity: LegacyEntity, newId: string, limit = 10): Promise<string[]> {
  const rows = await tx
    .select({ legacyId: legacyIdMaps.legacyId })
    .from(legacyIdMaps)
    .where(and(eq(legacyIdMaps.entity, entity), eq(legacyIdMaps.newId, newId)))
    .limit(limit);
  return rows.map((r) => r.legacyId);
}

/** Taxonomy entities: platform reference data, the only maps `app_public` may read (S8-02 registry predicate). */
export const TAXONOMY_ENTITIES = ['location', 'propertyType', 'feature'] as const;

/**
 * Every taxonomy map (S8-02, the v1 shim's filter ids): one statement, read whole into a per-process map. A few
 * thousand rows (the legacy taxonomy); `limit` guards a runaway table.
 */
export async function taxonomyMaps(
  tx: Tx,
  limit: number,
): Promise<{ entity: string; legacyId: string; newId: string }[]> {
  const res = await tx.execute(sql`
    select m.entity, m.legacy_id as "legacyId", m.new_id as "newId" from ${legacyIdMaps} m
     where m.entity in ('location', 'propertyType', 'feature') order by m.entity, m.legacy_id limit ${limit}`);
  return res.rows as { entity: string; legacyId: string; newId: string }[];
}

/**
 * Listing and unit targets of these legacy ids (S8-02): through the SECURITY DEFINER `legacy_target_ids` — `app_public`
 * cannot read those maps, the function answers only the ids asked for (index probes, ≤ 1,000).
 */
export async function listingTargetsOf(
  tx: Tx,
  legacyIds: readonly string[],
): Promise<{ entity: string; legacyId: string; newId: string }[]> {
  if (legacyIds.length === 0) return [];
  const res = await tx.execute(sql`
    select t.entity, t.legacy_id as "legacyId", t.new_id as "newId"
      from public.legacy_target_ids(array[${sql.join(
        legacyIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[]) t`);
  return res.rows as { entity: string; legacyId: string; newId: string }[];
}

/**
 * A JSON subquery (S8-02): `{ newId: legacyId }` of these listing and unit ids, through the SECURITY DEFINER
 * `legacy_ids_of` (the smallest legacy id when several became one). Composed into the caller's statement, so a
 * page's legacy ids cost no statement of their own; served by `legacy_id_maps_new_idx`.
 */
export function listingLegacyIdsJson(newIds: readonly string[]): SQL {
  if (newIds.length === 0) return sql`'{}'::json`;
  return sql`(select coalesce(json_object_agg(x.new_id, x.legacy_id), '{}'::json)
    from public.legacy_ids_of(array[${sql.join(
      [...new Set(newIds)].map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]) x)`;
}

// ── Load checkpoints (S14-02) ─────────────────────────────────────────────────────────────────────────────────────

export type CheckpointRow = {
  seq: number;
  inputHash: string;
  status: 'DONE' | 'FAILED';
  counts: Record<string, Record<string, number>>;
  issues: unknown[];
  attempts: number;
};

/** Every checkpoint of one entity of a legacy agency, in order. One statement (`migration_batches_batch_uq`). */
export async function checkpoints(tx: Tx, legacyAgencyId: string, entity: string): Promise<CheckpointRow[]> {
  return (await tx
    .select({
      seq: migrationBatches.seq,
      inputHash: migrationBatches.inputHash,
      status: migrationBatches.status,
      counts: migrationBatches.counts,
      issues: migrationBatches.issues,
      attempts: migrationBatches.attempts,
    })
    .from(migrationBatches)
    .where(and(eq(migrationBatches.legacyAgencyId, legacyAgencyId), eq(migrationBatches.entity, entity)))
    .orderBy(migrationBatches.seq)) as CheckpointRow[];
}

/** Records a batch's outcome (insert or replace on agency, entity, seq); a repeated attempt counts up. */
export async function saveCheckpoint(
  tx: Tx,
  row: {
    legacyAgencyId: string;
    targetAgencyId: string;
    entity: string;
    seq: number;
    inputHash: string;
    status: 'DONE' | 'FAILED';
    rows: number;
    counts: unknown;
    issues: unknown;
    error: string | null;
  },
): Promise<void> {
  await tx
    .insert(migrationBatches)
    .values({ id: newId(), ...row })
    .onConflictDoUpdate({
      target: [migrationBatches.legacyAgencyId, migrationBatches.entity, migrationBatches.seq],
      set: {
        targetAgencyId: sql`excluded.target_agency_id`,
        inputHash: sql`excluded.input_hash`,
        status: sql`excluded.status`,
        rows: sql`excluded.rows`,
        counts: sql`excluded.counts`,
        issues: sql`excluded.issues`,
        error: sql`excluded.error`,
        attempts: sql`${migrationBatches.attempts} + 1`,
        updatedAt: sql`now()`,
      },
    });
}
