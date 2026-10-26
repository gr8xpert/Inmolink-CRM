/**
 * migration queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/migration` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import { legacyIdMaps, legacyUrlRedirects, migrationBatches } from '@inmolink/db/schema/migration';
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
        set: {
          newId: sql`excluded.new_id`,
          // S14 review: `matched` (a re-run finding the row the load created) keeps the map's method for the same row.
          method: sql`case when ${legacyIdMaps.newId} = excluded.new_id and excluded.method = 'matched'
                           then ${legacyIdMaps.method} else excluded.method end`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${legacyIdMaps.method} <> 'manual'
          and ${legacyIdMaps.targetAgencyId} is not distinct from excluded.target_agency_id`,
      });
  }
}

/**
 * S14 review: which of these v2 rows of the agency the load created (`import` maps; `legacy_id_maps_new_idx`). One
 * statement.
 */
export async function importedAmong(
  tx: Tx,
  entity: LegacyEntity,
  agencyId: string,
  newIds: readonly string[],
): Promise<Set<string>> {
  if (newIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ newId: legacyIdMaps.newId })
    .from(legacyIdMaps)
    .where(
      and(
        eq(legacyIdMaps.entity, entity),
        inArray(legacyIdMaps.newId, [...newIds]),
        eq(legacyIdMaps.targetAgencyId, agencyId),
        eq(legacyIdMaps.method, 'import'),
      ),
    );
  return new Set(rows.map((r) => r.newId));
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

/**
 * S14 review: drops an entity's checkpoints past its last batch (`seq > lastSeq`; -1 drops all) — a re-extract with
 * fewer rows, or a smaller delta, leaves no stale DONE / FAILED rows behind for validation. One statement
 * (`migration_batches_batch_uq` range). Answers the rows removed.
 */
export async function deleteCheckpointsAfter(
  tx: Tx,
  legacyAgencyId: string,
  entity: string,
  lastSeq: number,
): Promise<number> {
  const gone = await tx
    .delete(migrationBatches)
    .where(
      and(
        eq(migrationBatches.legacyAgencyId, legacyAgencyId),
        eq(migrationBatches.entity, entity),
        sql`${migrationBatches.seq} > ${lastSeq}`,
      ),
    )
    .returning({ id: migrationBatches.id });
  return gone.length;
}

// ---- S14-05: legacy URL redirects ----

export type RedirectRow = {
  source: 'portal' | 'plugin';
  /** The legacy site's host (`normalizeHost`): plugin pages of two agencies may share a path. */
  host: string;
  locale: string;
  pathKey: string;
  targetPath: string;
  entity: string;
  targetId: string | null;
  status: 301 | 308;
};

/** One redirect by its key: one probe on `legacy_url_redirects_key_uq`. */
export async function redirectByKey(
  tx: Tx,
  source: string,
  host: string,
  locale: string,
  pathKey: string,
): Promise<{ targetPath: string; status: number } | null> {
  const [row] = await tx
    .select({ targetPath: legacyUrlRedirects.targetPath, status: legacyUrlRedirects.status })
    .from(legacyUrlRedirects)
    .where(
      and(
        eq(legacyUrlRedirects.source, source),
        eq(legacyUrlRedirects.host, host),
        eq(legacyUrlRedirects.locale, locale),
        eq(legacyUrlRedirects.pathKey, pathKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Idempotent upsert of a batch (up to 1,000 per statement); a changed target replaces the old one, hits are kept. */
export async function upsertRedirects(tx: Tx, rows: readonly RedirectRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += 1000) {
    await tx
      .insert(legacyUrlRedirects)
      .values(rows.slice(i, i + 1000).map((r) => ({ id: newId(), ...r })))
      .onConflictDoUpdate({
        target: [
          legacyUrlRedirects.source,
          legacyUrlRedirects.host,
          legacyUrlRedirects.locale,
          legacyUrlRedirects.pathKey,
        ],
        set: {
          targetPath: sql`excluded.target_path`,
          entity: sql`excluded.entity`,
          targetId: sql`excluded.target_id`,
          status: sql`excluded.status`,
          updatedAt: sql`now()`,
        },
      });
  }
  return rows.length;
}

export type RedirectHit = { source: string; host: string; locale: string; pathKey: string; hits: number };

/** Adds counted hits, one statement per 1,000 URLs (the flush). */
export async function addRedirectHits(tx: Tx, hits: readonly RedirectHit[], at: Date): Promise<void> {
  for (let i = 0; i < hits.length; i += 1000) {
    await tx.execute(sql`
      update public.legacy_url_redirects r
         set hits = r.hits + h.hits, last_hit_at = ${at.toISOString()}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(hits.slice(i, i + 1000))}::jsonb)
             as h(source text, host text, locale text, "pathKey" text, hits int)
       where r.source = h.source and r.host = h.host and r.locale = h.locale and r.path_key = h."pathKey"`);
  }
}

// ---- S14-04: delta sync ----

/** Legacy agencies and the v2 agency each became (the `agency` maps), legacy id order after `after`. One statement. */
export async function legacyAgencyMaps(
  tx: Tx,
  after: string | null,
  limit: number,
): Promise<{ legacyAgencyId: string; agencyId: string }[]> {
  return tx
    .select({ legacyAgencyId: legacyIdMaps.legacyId, agencyId: legacyIdMaps.newId })
    .from(legacyIdMaps)
    .where(
      and(eq(legacyIdMaps.entity, 'agency'), after === null ? undefined : sql`${legacyIdMaps.legacyId} > ${after}`),
    )
    .orderBy(legacyIdMaps.legacyId)
    .limit(limit);
}

/** The checkpoint rows of one key (`delta:state`) of these legacy agencies. One statement (`migration_batches_batch_uq`). */
export async function checkpointsOf(
  tx: Tx,
  legacyAgencyIds: readonly string[],
  entity: string,
): Promise<{ legacyAgencyId: string; seq: number; counts: Record<string, Record<string, number>> }[]> {
  if (legacyAgencyIds.length === 0) return [];
  return (await tx
    .select({
      legacyAgencyId: migrationBatches.legacyAgencyId,
      seq: migrationBatches.seq,
      counts: migrationBatches.counts,
    })
    .from(migrationBatches)
    .where(
      and(inArray(migrationBatches.legacyAgencyId, [...legacyAgencyIds]), eq(migrationBatches.entity, entity)),
    )) as { legacyAgencyId: string; seq: number; counts: Record<string, Record<string, number>> }[];
}
