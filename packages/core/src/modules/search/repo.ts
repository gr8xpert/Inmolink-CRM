/**
 * search queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/search` — other modules' tables fail `pnpm check:boundaries`.
 * Read models are written by the search worker only (`withSystem`).
 */
import type { Tx } from '@inmolink/db';
import { listingReadModels, searchIndexQueue } from '@inmolink/db/schema/search';
import { newId } from '@inmolink/platform/ids';
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
 * different content (media processed, a taxonomy rename) or share scope: never backwards, and an unchanged rebuild
 * writes nothing.
 */
export async function upsertDocs(tx: Tx, docs: readonly BuiltDoc[]): Promise<string[]> {
  if (docs.length === 0) return [];
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
        shareScope: d.shareScope,
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
        shareScope: excluded('share_scope'),
        version: excluded('version'),
        card: excluded('card'),
        detail: excluded('detail'),
        etag: excluded('etag'),
        updatedAt: sql`now()`,
      },
      // Share scope is not in the documents (no etag change): a bulk scope change must still reach the row.
      setWhere: sql`excluded.version > ${listingReadModels.version}
        or (excluded.version = ${listingReadModels.version}
            and (excluded.etag <> ${listingReadModels.etag}
                 or excluded.share_scope is distinct from ${listingReadModels.shareScope}))`,
    })
    .returning({ targetId: listingReadModels.targetId });
  return rows.map((r) => r.targetId);
}

/** Deletes the documents of `ids` not in `keep` (gone targets, removed locales); answers their targets. PK probes. */
export async function deleteOthers(
  tx: Tx,
  ids: readonly string[],
  keep: readonly { targetId: string; locale: string }[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const kept =
    keep.length === 0
      ? sql``
      : sql`and (target_id, locale) not in (select * from unnest(${uuidArray(keep.map((k) => k.targetId))},
          array[${sql.join(
            keep.map((k) => sql`${k.locale}`),
            sql`, `,
          )}]::text[]))`;
  const res = await tx.execute(sql`
    delete from ${listingReadModels} where target_id = any(${uuidArray(ids)}) ${kept} returning target_id`);
  return (res.rows as { target_id: string }[]).map((r) => r.target_id);
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
): Promise<string[]> {
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
  const res = await tx.execute(
    sql`delete from ${listingReadModels} where ${sql.join(conditions, sql` and `)} returning target_id`,
  );
  return (res.rows as { target_id: string }[]).map((r) => r.target_id);
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

/**
 * These targets' rows as the index builder reads them: the card, and only the description and features of the
 * detail (not its media). Primary key range scans per target.
 */
export async function readIndexRows(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      targetId: listingReadModels.targetId,
      locale: listingReadModels.locale,
      kind: listingReadModels.kind,
      agencyId: listingReadModels.agencyId,
      developmentId: listingReadModels.developmentId,
      public: listingReadModels.public,
      status: listingReadModels.status,
      shareScope: listingReadModels.shareScope,
      version: listingReadModels.version,
      etag: listingReadModels.etag,
      card: listingReadModels.card,
      description: sql<string | null>`${listingReadModels.detail}->>'description'`,
      features: sql<{ id: string }[] | null>`${listingReadModels.detail}->'features'`,
      createdAt: listingReadModels.createdAt,
    })
    .from(listingReadModels)
    .where(inArray(listingReadModels.targetId, [...ids]));
}

// ---------------------------------------------------------------------------------------------------------------
// Search index sync queue (S5-03)

/**
 * Queues these targets' index documents for a push, in the read-model change's transaction. A target already
 * queued gets a new generation (a sync holding it pushes again later) and keeps its place (`queued_at`: a target
 * edited again and again is not starved by the backlog); a rejected document's backoff ends — a change may fix it.
 * One statement for any number; rows in id order (no deadlock between two writers).
 */
export async function queueIndexSync(tx: Tx, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  await tx.execute(sql`
    insert into ${searchIndexQueue} (target_id)
    select x from unnest(${uuidArray(unique)}) as x order by 1
    on conflict (target_id) do update
      set generation = ${searchIndexQueue}.generation + 1, not_before = null`);
}

export interface IndexSyncClaim {
  /** Marks the claimed rows: finishing or releasing touches only rows this claim still holds. */
  token: string;
  rows: { targetId: string; generation: number }[];
}

/**
 * Claims up to `limit` queued targets, oldest first, that no live sync holds and that are not backing off, for
 * `leaseMs`. Rows a concurrent claim is taking are skipped, never waited for. `search_index_queue_queued_idx`.
 */
export async function claimIndexSync(
  tx: Tx,
  limit: number,
  leaseMs: number,
  only?: readonly string[],
): Promise<IndexSyncClaim> {
  const token = newId();
  const res = await tx.execute(sql`
    update ${searchIndexQueue} q
       set claimed_until = now() + make_interval(secs => ${leaseMs / 1000}), claim_token = ${token},
           attempts = q.attempts + 1
      from (select target_id from ${searchIndexQueue}
             where (claimed_until is null or claimed_until < now())
               and (not_before is null or not_before < now())
               ${only === undefined ? sql`` : sql`and target_id = any(${uuidArray(only)})`}
             order by queued_at
             limit ${limit}
               for update skip locked) c
     where q.target_id = c.target_id
    returning q.target_id, q.generation`);
  return {
    token,
    rows: (res.rows as { target_id: string; generation: number }[]).map((r) => ({
      targetId: r.target_id,
      generation: r.generation,
    })),
  };
}

/**
 * Pushed: deletes the claimed rows whose generation is unchanged and frees the others (changed again since the
 * claim: the next sync pushes them). Rows another claim took over (this lease expired) are left alone. Answers the
 * rows deleted.
 */
export async function finishIndexSync(tx: Tx, claim: IndexSyncClaim): Promise<number> {
  if (claim.rows.length === 0) return 0;
  const generations = sql`array[${sql.join(
    claim.rows.map((c) => sql`${c.generation}`),
    sql`, `,
  )}]::int[]`;
  const res = await tx.execute(sql`
    delete from ${searchIndexQueue} q
     using unnest(${uuidArray(claim.rows.map((c) => c.targetId))}, ${generations}) as c(target_id, generation)
     where q.target_id = c.target_id and q.generation = c.generation and q.claim_token = ${claim.token}`);
  await releaseIndexSync(tx, claim.token);
  return res.rowCount ?? 0;
}

/** Not pushed (the engine failed, or the lease ran short): frees the rows this claim still holds. */
export async function releaseIndexSync(tx: Tx, token: string): Promise<void> {
  await tx.execute(sql`
    update ${searchIndexQueue} set claimed_until = null, claim_token = null where claim_token = ${token}`);
}

/**
 * Documents the engine rejected (not a failure of the engine): these rows back off — 2^attempts seconds, at most an
 * hour — so the rest of the queue keeps flowing. Answers their attempts (alerting).
 */
export async function backOffIndexSync(
  tx: Tx,
  token: string,
  ids: readonly string[],
): Promise<{ targetId: string; attempts: number }[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute(sql`
    update ${searchIndexQueue}
       set claimed_until = null, claim_token = null,
           not_before = now() + make_interval(secs => least(power(2, least(attempts, 12)), 3600))
     where claim_token = ${token} and target_id = any(${uuidArray(ids)})
    returning target_id, attempts`);
  return (res.rows as { target_id: string; attempts: number }[]).map((r) => ({
    targetId: r.target_id,
    attempts: r.attempts,
  }));
}

/** Queue depth and the oldest row's age (freshness lag, PLAN §5.3 #14). */
export async function indexSyncBacklog(
  tx: Tx,
  only?: readonly string[],
): Promise<{ queued: number; oldestAgeMs: number }> {
  const res = await tx.execute(sql`
    select count(*)::int as queued,
           coalesce(extract(epoch from now() - min(queued_at)) * 1000, 0)::float8 as oldest
      from ${searchIndexQueue}
     ${only === undefined ? sql`` : sql`where target_id = any(${uuidArray(only)})`}`);
  const row = res.rows[0] as { queued: number; oldest: number };
  return { queued: row.queued, oldestAgeMs: row.oldest };
}

/** Which of these targets are queued (a drift sample skips them: their push is pending, not lost). */
export async function queuedOf(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ targetId: searchIndexQueue.targetId })
    .from(searchIndexQueue)
    .where(inArray(searchIndexQueue.targetId, [...ids]));
  return new Set(rows.map((r) => r.targetId));
}

// ---------------------------------------------------------------------------------------------------------------
// Drift check and repair (S5-03)

/** Targets with read models (each once): the index should hold this many documents. Index-only scan of the PK. */
export async function countTargets(tx: Tx, only?: readonly string[]): Promise<number> {
  const res = await tx.execute(sql`select count(distinct target_id)::int as n from ${listingReadModels}
    ${only === undefined ? sql`` : sql`where target_id = any(${uuidArray(only)})`}`);
  return (res.rows[0] as { n: number }).n;
}

/**
 * About `size` random targets: a block sample of the read models (`tablesample system`, sized from the planner's
 * row estimate; a small table is read whole). Clustered by block, not uniform per target: enough to notice drift.
 */
export async function sampleTargets(tx: Tx, size: number): Promise<string[]> {
  const est = await tx.execute(sql`
    select greatest(reltuples, 0)::float8 as rows from pg_class where oid = 'listing_read_models'::regclass`);
  const rows = (est.rows[0] as { rows: number } | undefined)?.rows ?? 0;
  // Up to six rows (locales) per target: sample enough rows for `size` targets, then cut.
  const n = Math.max(1, Math.floor(size));
  const percent = rows < n * 60 ? 100 : Math.min(100, ((n * 6 * 2) / rows) * 100);
  const res = await tx.execute(sql`
    select distinct target_id from ${listingReadModels} tablesample system (${percent}::float4)
     limit ${n}`);
  return (res.rows as { target_id: string }[]).map((r) => r.target_id);
}

/** A page of targets with read models in id order (repair walk). Primary key index scan. */
export async function targetPage(
  tx: Tx,
  after: string | null,
  limit: number,
  only?: readonly string[],
): Promise<string[]> {
  const conditions: SQL[] = [
    ...(after === null ? [] : [sql`target_id > ${after}`]),
    ...(only === undefined ? [] : [sql`target_id = any(${uuidArray(only)})`]),
  ];
  const res = await tx.execute(sql`
    select distinct target_id from ${listingReadModels}
     ${conditions.length === 0 ? sql`` : sql`where ${sql.join(conditions, sql` and `)}`}
     order by target_id limit ${limit}`);
  return (res.rows as { target_id: string }[]).map((r) => r.target_id);
}

/** Which of these targets have read models (repair: index documents of the others are orphans). PK probes. */
export async function existingTargets(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await tx.execute(sql`
    select distinct target_id from ${listingReadModels} where target_id = any(${uuidArray(ids)})`);
  return new Set((res.rows as { target_id: string }[]).map((r) => r.target_id));
}
