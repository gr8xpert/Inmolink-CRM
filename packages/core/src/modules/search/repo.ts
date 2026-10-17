/**
 * search queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/search` — other modules' tables fail `pnpm check:boundaries`.
 * Read models are written by the search worker only (`withSystem`).
 */
import type { Tx } from '@inmolink/db';
import { listingReadModels } from '@inmolink/db/schema/search';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { BuiltDoc } from './build';

type Kind = BuiltDoc['kind'];

const uuidArray = (ids: readonly string[]) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

/**
 * Serialises builders of these targets until the transaction ends (advisory, keys in one order: no deadlock). A
 * builder that holds the lock reads its sources after the previous one committed, so a later write is never older
 * data than an earlier one — together with the version guard the read model never goes backwards.
 */
export async function lockTargets(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    select pg_advisory_xact_lock(k)
      from (select distinct hashtextextended('read_model:' || x::text, 0) as k
              from unnest(${uuidArray(ids)}) as x
             order by 1) s`);
}

/**
 * Upserts documents in one statement. A row changes only with a newer source version, or the same version and
 * different content (media processed, a taxonomy rename): never backwards, and an unchanged rebuild writes nothing.
 */
export async function upsertDocs(tx: Tx, docs: readonly BuiltDoc[]): Promise<number> {
  if (docs.length === 0) return 0;
  const excluded = (c: string) => sql.raw(`excluded.${c}`);
  const rows = await tx
    .insert(listingReadModels)
    .values(
      docs.map((d) => ({
        targetId: d.targetId,
        locale: d.locale,
        kind: d.kind,
        agencyId: d.agencyId,
        developmentId: d.developmentId,
        public: d.public,
        status: d.status,
        version: d.version,
        card: d.card,
        detail: d.detail,
        etag: d.etag,
      })),
    )
    .onConflictDoUpdate({
      target: [listingReadModels.targetId, listingReadModels.locale],
      set: {
        kind: excluded('kind'),
        agencyId: excluded('agency_id'),
        developmentId: excluded('development_id'),
        public: excluded('public'),
        status: excluded('status'),
        version: excluded('version'),
        card: excluded('card'),
        detail: excluded('detail'),
        etag: excluded('etag'),
        updatedAt: sql`now()`,
      },
      setWhere: sql`excluded.version > ${listingReadModels.version}
        or (excluded.version = ${listingReadModels.version} and excluded.etag <> ${listingReadModels.etag})`,
    })
    .returning({ targetId: listingReadModels.targetId });
  return rows.length;
}

/** Deletes the documents of `ids` not in `keep` (gone targets, removed locales). Primary key probes. */
export async function deleteOthers(
  tx: Tx,
  ids: readonly string[],
  keep: readonly { targetId: string; locale: string }[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const kept =
    keep.length === 0
      ? sql``
      : sql`and (target_id, locale) not in (select * from unnest(${uuidArray(keep.map((k) => k.targetId))},
          array[${sql.join(
            keep.map((k) => sql`${k.locale}`),
            sql`, `,
          )}]::text[]))`;
  const res = await tx.execute(sql`
    delete from ${listingReadModels} where target_id = any(${uuidArray(ids)}) ${kept}`);
  return res.rowCount ?? 0;
}

/**
 * The full rebuild walks live targets in id order; a document of `kind` between two consecutive live targets
 * (`after` exclusive, `until` inclusive, null: unbounded) whose target is not one of them has none any more —
 * unless an event rebuilt it since the run's page was read (`updated_at >= since`). The primary key range, or
 * `listing_read_models_agency_idx` for one agency.
 */
export async function deleteBetween(
  tx: Tx,
  range: {
    kind: Kind;
    after: string | null;
    until: string | null;
    live: readonly string[];
    since: Date;
    agencyId?: string;
  },
): Promise<number> {
  const conditions: SQL[] = [
    sql`kind = ${range.kind}`,
    sql`updated_at < ${range.since}`,
    ...(range.after === null ? [] : [sql`target_id > ${range.after}`]),
    ...(range.until === null ? [] : [sql`target_id <= ${range.until}`]),
    ...(range.live.length === 0 ? [] : [sql`not (target_id = any(${uuidArray(range.live)}))`]),
    ...(range.agencyId === undefined ? [] : [sql`agency_id = ${range.agencyId}`]),
    // A target a builder holds is being rebuilt (it decides): skip it rather than wait — and never deadlock.
    sql`pg_try_advisory_xact_lock(hashtextextended('read_model:' || target_id::text, 0))`,
  ];
  const res = await tx.execute(sql`delete from ${listingReadModels} where ${sql.join(conditions, sql` and `)}`);
  return res.rowCount ?? 0;
}

/** The database's clock (a full rebuild compares `updated_at` with it). */
export async function dbNow(tx: Tx): Promise<Date> {
  const res = await tx.execute(sql`select now() as now`);
  return new Date((res.rows[0] as { now: string | Date }).now);
}

/** Targets (and their kind) of a development's read models: units and listings that may no longer have one. */
export async function targetsOfDevelopment(tx: Tx, developmentId: string): Promise<{ targetId: string; kind: Kind }[]> {
  return tx
    .selectDistinct({ targetId: listingReadModels.targetId, kind: listingReadModels.kind })
    .from(listingReadModels)
    .where(eq(listingReadModels.developmentId, developmentId));
}

/** These targets' documents (tests and ops checks). */
export async function readDocs(tx: Tx, ids: readonly string[], locale?: string) {
  if (ids.length === 0) return [];
  return tx
    .select({
      targetId: listingReadModels.targetId,
      locale: listingReadModels.locale,
      kind: listingReadModels.kind,
      agencyId: listingReadModels.agencyId,
      public: listingReadModels.public,
      status: listingReadModels.status,
      version: listingReadModels.version,
      card: listingReadModels.card,
      detail: listingReadModels.detail,
      etag: listingReadModels.etag,
    })
    .from(listingReadModels)
    .where(
      and(
        inArray(listingReadModels.targetId, [...ids]),
        locale === undefined ? undefined : eq(listingReadModels.locale, locale),
      ),
    );
}
