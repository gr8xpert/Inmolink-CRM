/**
 * search queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/search` — other modules' tables fail `pnpm check:boundaries`.
 * Read models are written by the search worker only (`withSystem`).
 */

import { randomBytes } from 'node:crypto';
import type { Tx } from '@inmolink/db';
import {
  listingPublicCodes,
  listingReadModels,
  listingSearchDocs,
  readModelQueue,
  searchIndexQueue,
} from '@inmolink/db/schema/search';
import { newId } from '@inmolink/platform/ids';
import { type FieldValue, type Filter, SearchError } from '@inmolink/platform/search';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { BuiltDoc } from './build';
import type { ListingIndexDoc } from './index-doc';

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
        allowedAgencyIds: d.allowedAgencyIds,
        networkHidden: d.networkHidden,
        preferredAgencyIds: d.preferredAgencyIds,
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
        allowedAgencyIds: excluded('allowed_agency_ids'),
        networkHidden: excluded('network_hidden'),
        preferredAgencyIds: excluded('preferred_agency_ids'),
        version: excluded('version'),
        card: excluded('card'),
        detail: excluded('detail'),
        etag: excluded('etag'),
        updatedAt: sql`now()`,
      },
      // Share scope, the allowed agencies, `public`, the freshness flag and the owner's preferred list are not in the
      // documents (no etag change; S6-F1: the owner's status changes `public` without a new version; S6-F2: hiding
      // and the owner's list neither): a change of any must still reach the row.
      setWhere: sql`excluded.version > ${listingReadModels.version}
        or (excluded.version = ${listingReadModels.version}
            and (excluded.etag <> ${listingReadModels.etag}
                 or excluded.public <> ${listingReadModels.public}
                 or excluded.network_hidden <> ${listingReadModels.networkHidden}
                 or excluded.share_scope is distinct from ${listingReadModels.shareScope}
                 or excluded.allowed_agency_ids is distinct from ${listingReadModels.allowedAgencyIds}
                 or excluded.preferred_agency_ids is distinct from ${listingReadModels.preferredAgencyIds}))`,
    })
    .returning({ targetId: listingReadModels.targetId });
  return rows.map((r) => r.targetId);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A random public code: 8 Crockford base32 characters (40 bits). */
export const newPublicCode = () => Array.from(randomBytes(8), (b) => CROCKFORD[b & 31]).join('');

/**
 * Gives these targets a public code if they have none (S7-02): one statement — inserts a random code per target,
 * keeps existing ones, and answers the targets that got one now and those whose new code collided (rare: drawn
 * again by the caller).
 */
export async function insertPublicCodes(
  tx: Tx,
  ids: readonly string[],
): Promise<{ created: string[]; collided: string[] }> {
  if (ids.length === 0) return { created: [], collided: [] };
  const unique = [...new Set(ids)];
  const codes = unique.map(() => newPublicCode());
  const res = await tx.execute(sql`
    with ins as (
      insert into ${listingPublicCodes} (target_id, code)
      select t.id, t.code from unnest(${uuidArray(unique)}, ${sql`array[${sql.join(
        codes.map((c) => sql`${c}`),
        sql`, `,
      )}]::text[]`}) as t(id, code)
      on conflict do nothing
      returning target_id)
    select t.id as target_id, exists (select 1 from ins where ins.target_id = t.id) as created
      from unnest(${uuidArray(unique)}) as t(id)
     where exists (select 1 from ins where ins.target_id = t.id)
        or not exists (select 1 from ${listingPublicCodes} c where c.target_id = t.id)`);
  const rows = res.rows as { target_id: string; created: boolean }[];
  return {
    created: rows.filter((r) => r.created).map((r) => r.target_id),
    collided: rows.filter((r) => !r.created).map((r) => r.target_id),
  };
}

/** These targets' public codes (website serializer, S7-03 hydration). One statement by primary key. */
export async function publicCodes(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ targetId: listingPublicCodes.targetId, code: listingPublicCodes.code })
    .from(listingPublicCodes)
    .where(inArray(listingPublicCodes.targetId, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.targetId, r.code]));
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
      allowedAgencyIds: listingReadModels.allowedAgencyIds,
      networkHidden: listingReadModels.networkHidden,
      preferredAgencyIds: listingReadModels.preferredAgencyIds,
      version: listingReadModels.version,
      etag: listingReadModels.etag,
      card: listingReadModels.card,
      description: sql<string | null>`${listingReadModels.detail}->>'description'`,
      features: sql<{ id: string }[] | null>`${listingReadModels.detail}->'features'`,
      createdAt: listingReadModels.createdAt,
      publicCode: listingPublicCodes.code,
    })
    .from(listingReadModels)
    .leftJoin(listingPublicCodes, eq(listingPublicCodes.targetId, listingReadModels.targetId))
    .where(inArray(listingReadModels.targetId, [...ids]));
}

// ---------------------------------------------------------------------------------------------------------------
// Read-model rebuild queue (S5-F4)

export interface ReadModelChange {
  kind: Kind;
  targetId: string;
  agencyId: string;
}

/**
 * Queues rebuilds of these targets, due `delayMs` from now. A target already queued gets a new generation (a rebuild
 * holding it builds again later), a new due time (debounce: a burst is rebuilt once, after it settled) and its
 * image rechecks reset. One statement for any number; rows in id order (no deadlock between two writers).
 */
export async function queueReadModels(tx: Tx, changes: readonly ReadModelChange[], delayMs: number): Promise<void> {
  const unique = [...new Map(changes.map((c) => [c.targetId, c])).values()];
  if (unique.length === 0) return;
  const kinds = sql`array[${sql.join(
    unique.map((c) => sql`${c.kind}`),
    sql`, `,
  )}]::text[]`;
  await tx.execute(sql`
    insert into ${readModelQueue} (target_id, kind, owner_agency_id, due_at)
    select t, k, a, now() + make_interval(secs => ${delayMs / 1000})
      from unnest(${uuidArray(unique.map((c) => c.targetId))}, ${kinds},
                  ${uuidArray(unique.map((c) => c.agencyId))}) as x(t, k, a)
     order by 1
    on conflict (target_id) do update
      set generation = ${readModelQueue}.generation + 1, due_at = excluded.due_at, rechecks = 0`);
}

/**
 * Queues a rebuild of one page of an agency's targets of `kind` that have read models (S6-F1: its status decides
 * `public`), due `delayMs` from now, like `queueReadModels`: the next `limit` target ids after `after`, in
 * `listing_read_models_agency_idx` order (an index range, one statement). `preferredOnly`: its listings shared to
 * PREFERRED only (S6-F2: their documents carry its preferred list). Answers how many, and the page's last id (null:
 * the last page).
 */
export async function queueAgencyReadModels(
  tx: Tx,
  page: { agencyId: string; kind: Kind; after: string | null; limit: number; preferredOnly?: boolean },
  delayMs: number,
): Promise<{ queued: number; last: string | null }> {
  const after = page.after === null ? sql`` : sql`and target_id > ${page.after}`;
  const preferred = page.preferredOnly ? sql`and share_scope = 'PREFERRED'` : sql``;
  const res = await tx.execute<{ target_id: string }>(sql`
    with page as (
      select distinct target_id from ${listingReadModels}
       where agency_id = ${page.agencyId} and kind = ${page.kind} ${after} ${preferred}
       order by target_id limit ${page.limit})
    insert into ${readModelQueue} (target_id, kind, owner_agency_id, due_at)
    select target_id, ${page.kind}, ${page.agencyId}::uuid, now() + make_interval(secs => ${delayMs / 1000})
      from page order by 1
    on conflict (target_id) do update
      set generation = ${readModelQueue}.generation + 1, due_at = excluded.due_at, rechecks = 0
    returning target_id`);
  const ids = res.rows.map((r) => r.target_id).sort();
  return { queued: ids.length, last: ids.length < page.limit ? null : (ids.at(-1) ?? null) };
}

export interface ReadModelClaim {
  token: string;
  rows: { targetId: string; kind: Kind; generation: number }[];
}

/**
 * Claims up to `limit` of an agency's due targets, oldest first, that no live rebuild holds, for `leaseMs`. Rows a
 * concurrent claim is taking are skipped. `read_model_queue_agency_due_idx`.
 */
export async function claimReadModels(
  tx: Tx,
  agencyId: string,
  limit: number,
  leaseMs: number,
): Promise<ReadModelClaim> {
  const token = newId();
  const res = await tx.execute(sql`
    update ${readModelQueue} q
       set claimed_until = now() + make_interval(secs => ${leaseMs / 1000}), claim_token = ${token}
      from (select target_id from ${readModelQueue}
             where owner_agency_id = ${agencyId} and due_at <= now()
               and (claimed_until is null or claimed_until < now())
             order by due_at
             limit ${limit}
               for update skip locked) c
     where q.target_id = c.target_id
    returning q.target_id, q.kind, q.generation`);
  return {
    token,
    rows: (res.rows as { target_id: string; kind: Kind; generation: number }[]).map((r) => ({
      targetId: r.target_id,
      kind: r.kind,
      generation: r.generation,
    })),
  };
}

const claimedRows = (claim: ReadModelClaim, ids?: ReadonlySet<string>) => {
  const rows = ids ? claim.rows.filter((r) => ids.has(r.targetId)) : claim.rows;
  return sql`unnest(${uuidArray(rows.map((r) => r.targetId))}, array[${sql.join(
    rows.map((r) => sql`${r.generation}`),
    sql`, `,
  )}]::int[]) as c(target_id, generation)`;
};

/**
 * Images still processing: these claimed targets are rebuilt again `delayMs` later, at most `max` times — unless
 * they changed since the claim (that change's rebuild comes first anyway). Must run before `finishReadModels`.
 */
export async function rescheduleReadModels(
  tx: Tx,
  claim: ReadModelClaim,
  ids: readonly string[],
  max: number,
  delayMs: number,
): Promise<number> {
  const pending = new Set(ids);
  if (!claim.rows.some((r) => pending.has(r.targetId))) return 0;
  const res = await tx.execute(sql`
    update ${readModelQueue} q
       set rechecks = q.rechecks + 1, due_at = now() + make_interval(secs => ${delayMs / 1000}),
           claimed_until = null, claim_token = null
      from ${claimedRows(claim, pending)}
     where q.target_id = c.target_id and q.generation = c.generation and q.claim_token = ${claim.token}
       and q.rechecks < ${max}`);
  return res.rowCount ?? 0;
}

/**
 * Rebuilt (in the same transaction): deletes the claimed rows whose generation is unchanged and frees the others
 * (changed again since the claim: rebuilt again when due). Rows another claim took over are left alone.
 */
export async function finishReadModels(tx: Tx, claim: ReadModelClaim): Promise<void> {
  if (claim.rows.length === 0) return;
  await tx.execute(sql`
    delete from ${readModelQueue} q using ${claimedRows(claim)}
     where q.target_id = c.target_id and q.generation = c.generation and q.claim_token = ${claim.token}`);
  await releaseReadModels(tx, claim);
}

/**
 * Not rebuilt (the transaction failed): frees the rows this claim still holds — by primary key (S6-F3 review: the
 * token alone has no index, so this read the whole queue once per batch).
 */
export async function releaseReadModels(tx: Tx, claim: ReadModelClaim): Promise<void> {
  if (claim.rows.length === 0) return;
  await tx.execute(sql`
    update ${readModelQueue} set claimed_until = null, claim_token = null
     where target_id = any(${uuidArray(claim.rows.map((r) => r.targetId))}) and claim_token = ${claim.token}`);
}

/** Milliseconds until the agency's next unclaimed target is due (≤ 0: due now), or null when none is queued. */
export async function nextReadModelDue(tx: Tx, agencyId: string): Promise<number | null> {
  const res = await tx.execute(sql`
    select (extract(epoch from min(due_at) - now()) * 1000)::float8 as ms from ${readModelQueue}
     where owner_agency_id = ${agencyId} and (claimed_until is null or claimed_until < now())`);
  const ms = (res.rows[0] as { ms: number | null } | undefined)?.ms;
  return ms === null || ms === undefined ? null : ms;
}

/** Agencies with targets overdue by more than `overdueMs` and unclaimed (their job was lost): the sweep's work. */
export async function overdueReadModelAgencies(tx: Tx, overdueMs: number, limit: number): Promise<string[]> {
  const res = await tx.execute(sql`
    select distinct owner_agency_id from ${readModelQueue}
     where due_at < now() - make_interval(secs => ${overdueMs / 1000})
       and (claimed_until is null or claimed_until < now())
     limit ${limit}`);
  return (res.rows as { owner_agency_id: string }[]).map((r) => r.owner_agency_id);
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

// ---------------------------------------------------------------------------------------------------------------
// Postgres fallback search (S5-04)

const SEARCH_DOC_COLUMNS = [
  'kind',
  'owner_agency_id',
  'development_id',
  'status',
  'transaction_type',
  'property_type_id',
  'location_ids',
  'feature_ids',
  'price_cents',
  'price_on_request',
  'beds',
  'baths',
  'area_m2',
  'plot_m2',
  'lat',
  'lng',
  'ref',
  'public_code',
  'share_scope',
  'preferred_agency_ids',
  'network_hidden',
  'published_at',
  'version',
  'source_hash',
] as const;
const camel = (c: string) => c.replace(/_([a-z0-9])/g, (_, x: string) => x.toUpperCase());

/**
 * Writes the PUBLIC index documents' filter fields (one statement). A row changes only when its document did
 * (`sourceHash`, `version`): an unchanged rebuild writes nothing.
 */
export async function upsertSearchDocs(tx: Tx, docs: readonly ListingIndexDoc[]): Promise<void> {
  if (docs.length === 0) return;
  await tx
    .insert(listingSearchDocs)
    .values(
      docs.map((d) => ({
        targetId: d.id,
        kind: d.kind,
        ownerAgencyId: d.ownerAgencyId,
        developmentId: d.developmentId,
        status: d.status,
        transactionType: d.transactionType,
        propertyTypeId: d.propertyTypeId,
        locationIds: d.locationIds,
        featureIds: d.featureIds,
        priceCents: d.priceCents,
        priceOnRequest: d.priceOnRequest,
        beds: d.beds,
        baths: d.baths,
        areaM2: d.areaM2,
        plotM2: d.plotM2,
        lat: d.geo?.lat ?? null,
        lng: d.geo?.lng ?? null,
        ref: d.ref,
        publicCode: d.publicCode,
        shareScope: d.shareScope,
        preferredAgencyIds: d.preferredAgencyIds,
        networkHidden: d.networkHidden,
        publishedAt: d.publishedAt,
        version: d.version,
        sourceHash: d.sourceHash,
      })),
    )
    .onConflictDoUpdate({
      target: listingSearchDocs.targetId,
      set: {
        ...Object.fromEntries(SEARCH_DOC_COLUMNS.map((c) => [camel(c), sql.raw(`excluded.${c}`)])),
        updatedAt: sql`now()`,
      },
      // A row from before the network columns (S7-01) is rewritten by the next rebuild, changed or not.
      setWhere: sql`excluded.source_hash <> ${listingSearchDocs.sourceHash}
        or excluded.version <> ${listingSearchDocs.version} or ${listingSearchDocs.shareScope} is null
        or excluded.public_code is distinct from ${listingSearchDocs.publicCode}`,
    });
}

/** Drops the fallback rows of these targets (no read model any more, or no longer PUBLIC). PK probes. */
export async function deleteSearchDocs(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`delete from ${listingSearchDocs} where target_id = any(${uuidArray(ids)})`);
}

/** `ci`: text compared case-insensitively (`lower(col) = lower(value)`, the `lower(ref)` index). */
type ColumnType = 'text' | 'ci' | 'uuid' | 'bigint' | 'int' | 'numeric' | 'bool' | 'uuid[]';
type FieldSpec = { column: string; type: ColumnType } | { constant: string };

/**
 * Filterable fields of the listings index → fallback columns. `visibility` is a constant (every row is PUBLIC).
 * The network fields (S7-01: sites that show network listings) are null on rows written before they existed, so
 * such a row matches no network filter until a rebuild rewrites it.
 */
const FALLBACK_FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: { column: 'kind::text', type: 'text' },
  ownerAgencyId: { column: 'owner_agency_id', type: 'uuid' },
  developmentId: { column: 'development_id', type: 'uuid' },
  status: { column: 'status', type: 'text' },
  visibility: { constant: 'PUBLIC' },
  transactionType: { column: 'transaction_type', type: 'text' },
  propertyTypeId: { column: 'property_type_id', type: 'uuid' },
  locationIds: { column: 'location_ids', type: 'uuid[]' },
  featureIds: { column: 'feature_ids', type: 'uuid[]' },
  priceOnRequest: { column: 'price_on_request', type: 'bool' },
  priceCents: { column: 'price_cents', type: 'bigint' },
  beds: { column: 'beds', type: 'int' },
  baths: { column: 'baths', type: 'int' },
  areaM2: { column: 'area_m2', type: 'numeric' },
  plotM2: { column: 'plot_m2', type: 'numeric' },
  shareScope: { column: 'share_scope', type: 'text' },
  preferredAgencyIds: { column: 'preferred_agency_ids', type: 'uuid[]' },
  networkHidden: { column: 'network_hidden', type: 'bool' },
  publishedAt: { column: 'published_at', type: 'bigint' },
  // A reference typed in the search box (S7-02: the site's white-label rule decides which reference matches which
  // document, `website.refFilter`).
  ref: { column: 'ref', type: 'ci' },
  // A network listing's site reference (`<prefix>-<code>`, S7-02): codes are upper case, compared as stored.
  publicCode: { column: 'public_code', type: 'text' },
};

/** Sortable fields → fallback columns (`nullable`: rows without a value come last in either direction). */
const FALLBACK_SORTS: Readonly<Record<string, { column: string; nullable: boolean }>> = {
  publishedAt: { column: 'published_at', nullable: false },
  priceCents: { column: 'price_cents', nullable: true },
  beds: { column: 'beds', nullable: true },
  areaM2: { column: 'area_m2', nullable: true },
};

const NUMERIC: readonly ColumnType[] = ['bigint', 'int', 'numeric'];

function fieldOf(name: string): FieldSpec {
  const f = FALLBACK_FIELDS[name];
  if (!f) throw new SearchError(`field is not filterable in the fallback: ${name}`);
  return f;
}

function finite(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SearchError('filter value must be a finite number');
  return v;
}

const paramOf = (type: ColumnType, v: FieldValue) => (NUMERIC.includes(type) ? finite(v) : v);

function typedArray(values: readonly FieldValue[], type: ColumnType): SQL {
  const element = type === 'uuid[]' ? 'uuid' : type;
  return sql`array[${sql.join(
    values.map((v) => sql`${paramOf(element as ColumnType, v)}`),
    sql`, `,
  )}]::${sql.raw(element)}[]`;
}

/**
 * The engine-neutral filter → a SQL condition on `listing_search_docs`, with the engine's semantics: an array field
 * equals a value when it holds it (`@>`) and is `in` values when it shares one (`&&`); a range never matches a null.
 * Values are always parameters; column names come from the map above, never from the caller.
 */
export function fallbackCondition(filter: Filter): SQL {
  switch (filter.op) {
    case 'and':
    case 'or': {
      if (filter.filters.length === 0) throw new SearchError(`empty ${filter.op}`);
      return sql`(${sql.join(filter.filters.map(fallbackCondition), sql.raw(filter.op === 'and' ? ' and ' : ' or '))})`;
    }
    case 'not':
      return sql`(not coalesce(${fallbackCondition(filter.filter)}, false))`;
    case 'eq': {
      const f = fieldOf(filter.field);
      if ('constant' in f) return filter.value === f.constant ? sql`true` : sql`false`;
      if (f.type === 'uuid[]') return sql`${sql.raw(f.column)} @> ${typedArray([filter.value], f.type)}`;
      if (f.type === 'ci') return sql`lower(${sql.raw(f.column)}) = lower(${String(filter.value)})`;
      return sql`${sql.raw(f.column)} = ${paramOf(f.type, filter.value)}`;
    }
    case 'in': {
      if (filter.values.length === 0) throw new SearchError('empty in');
      const f = fieldOf(filter.field);
      if ('constant' in f) return filter.values.includes(f.constant) ? sql`true` : sql`false`;
      if (f.type === 'uuid[]') return sql`${sql.raw(f.column)} && ${typedArray(filter.values, f.type)}`;
      if (f.type === 'ci') {
        return sql`lower(${sql.raw(f.column)}) in (${sql.join(
          filter.values.map((v) => sql`lower(${String(v)})`),
          sql`, `,
        )})`;
      }
      return sql`${sql.raw(f.column)} = any(${typedArray(filter.values, f.type)})`;
    }
    case 'range': {
      const f = fieldOf(filter.field);
      if ('constant' in f || !NUMERIC.includes(f.type))
        throw new SearchError(`field is not comparable: ${filter.field}`);
      const parts: SQL[] = [sql`${sql.raw(f.column)} is not null`];
      if (filter.gte !== undefined) parts.push(sql`${sql.raw(f.column)} >= ${finite(filter.gte)}`);
      if (filter.lte !== undefined) parts.push(sql`${sql.raw(f.column)} <= ${finite(filter.lte)}`);
      return sql`(${sql.join(parts, sql` and `)})`;
    }
    case 'gt':
      // Keyset walks of the engine only (S6-F2); no search filter uses it.
      throw new SearchError(`gt is not supported by the fallback: ${filter.field}`);
    case 'geoBox': {
      const [n, s, w, e] = [filter.north, filter.south, filter.west, filter.east].map(finite) as [
        number,
        number,
        number,
        number,
      ];
      // A box across the antimeridian (west > east) wraps.
      const lng = w <= e ? sql`lng between ${w} and ${e}` : sql`(lng >= ${w} or lng <= ${e})`;
      return sql`(lat between ${s} and ${n} and ${lng})`;
    }
    case 'geoRadius': {
      const [lat, lng, m] = [filter.lat, filter.lng, filter.meters].map(finite) as [number, number, number];
      // The circle's bounding box first (index-friendly), then the haversine distance in meters.
      const dLat = m / 111_320;
      const dLng = m / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
      return sql`(lat between ${lat - dLat} and ${lat + dLat}
        and lng between ${lng - dLng} and ${lng + dLng}
        and 12742000 * asin(sqrt(power(sin(radians(lat - ${lat}) / 2), 2)
          + cos(radians(${lat})) * cos(radians(lat)) * power(sin(radians(lng - ${lng}) / 2), 2))) <= ${m})`;
    }
  }
}

export interface FallbackPosition {
  /** 0: rows with a sort value; 1: rows without one (they come last). */
  phase: 0 | 1;
  /** The last row's sort value (phase 0), else null. */
  value: number | null;
  id: string;
}

export interface FallbackQuery {
  /** The site's filter, with a typed reference as a `ref` / `publicCode` condition (the fallback's only text match). */
  filter: Filter;
  sort: { field: string; dir: 'asc' | 'desc' };
  limit: number;
  /** Keyset: the page after this row. */
  after?: FallbackPosition;
  /** `total` is exact up to this many rows. */
  countCap: number;
}

/**
 * One page of the fallback, its total (exact up to `countCap`) and the next position, in one statement. Order: the
 * sort value, then the id; rows without a value last in either direction. Pages continue by keyset — over the capped
 * matches, or each branch an index-ordered scan with a limit — not by a growing OFFSET.
 */
export async function fallbackSearch(
  tx: Tx,
  q: FallbackQuery,
): Promise<{ ids: string[]; total: number; next: FallbackPosition | null }> {
  const res = await tx.execute(fallbackSearchSql(q));
  const rows = res.rows as { total: number; target_id: string | null; k: number | null; phase: 0 | 1 }[];
  const hits = rows.flatMap((r) => (r.target_id === null ? [] : [{ ...r, target_id: r.target_id }]));
  const page = hits.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    ids: page.map((r) => r.target_id),
    total: rows[0]?.total ?? 0,
    next: hits.length > q.limit && last ? { phase: last.phase, value: last.k, id: last.target_id } : null,
  };
}

/** The fallback's one statement (`fallbackSearch`; perf tests EXPLAIN it). */
export function fallbackSearchSql(q: FallbackQuery): SQL {
  const sort = FALLBACK_SORTS[q.sort.field];
  if (!sort) throw new SearchError(`field is not sortable in the fallback: ${q.sort.field}`);
  const col = sql.raw(sort.column);
  const dir = sql.raw(q.sort.dir);
  const cmp = sql.raw(q.sort.dir === 'asc' ? '>' : '<');
  const where = fallbackCondition(q.filter);
  const take = q.limit + 1;
  const branches: SQL[] = [];
  if (!q.after || q.after.phase === 0) {
    const keyset = q.after ? sql`and (${col}, target_id) ${cmp} (${q.after.value}, ${q.after.id}::uuid)` : sql``;
    branches.push(sql`(select target_id, ${col}::float8 as k, 0 as phase from ${listingSearchDocs}
       where ${where} ${sort.nullable ? sql`and ${col} is not null` : sql``} ${keyset}
       order by ${col} ${dir}, target_id ${dir} limit ${take})`);
  }
  if (sort.nullable) {
    const keyset = q.after?.phase === 1 ? sql`and target_id ${cmp} ${q.after.id}::uuid` : sql``;
    branches.push(sql`(select target_id, null::float8 as k, 1 as phase from ${listingSearchDocs}
       where ${where} and ${col} is null ${keyset}
       order by target_id ${dir} limit ${take})`);
  }
  if (branches.length === 0) throw new SearchError(`no rows without a value when sorting by ${q.sort.field}`);
  // The filter is matched once (S5-F4): `m` holds at most `countCap + 1` matches with their sort value. Within the cap
  // (selective filters, most searches) it gives the total and the page — sorted in memory, no second index walk. Past
  // it, the total is the cap and the page comes from the index-ordered branches (a broad filter finds its first page
  // in a few index entries). Each side is gated by an InitPlan, so only one of them runs.
  const after = !q.after
    ? sql``
    : q.after.phase === 0
      ? sql`and ((k is not null and (k, target_id) ${cmp} (${q.after.value}::float8, ${q.after.id}::uuid)) or k is null)`
      : sql`and k is null and target_id ${cmp} ${q.after.id}::uuid`;
  return sql`
    with m as materialized (
      select target_id, ${col}::float8 as k from ${listingSearchDocs} where ${where} limit ${q.countCap + 1}),
    c as materialized (select count(*)::int as n from m)
    select least(c.n, ${q.countCap}) as total, p.target_id, p.k, p.phase
      from c
      left join lateral (
        (select target_id, k, (k is null)::int as phase from m
          where (select n from c) <= ${q.countCap} ${after}
          order by phase, k ${dir}, target_id ${dir}
         limit ${q.limit + 1})
        union all
        (select * from (${sql.join(branches, sql` union all `)}) u
          where (select n from c) > ${q.countCap}
          order by phase, k ${dir}, target_id ${dir}
         limit ${q.limit + 1})) p on true
     order by p.phase, p.k ${dir}, p.target_id ${dir}`;
}

/**
 * Network search hydration (S5-05): each target's card in the best locale it has — `locale`, then `fallback`, then
 * any — read as `app_user`, so another agency's row is returned only where the reader may read the listing or unit
 * itself (the read models' network policy). S6-F3: the viewer's locale and the fallback are read first (two
 * primary-key probes per target); only a target with neither reads one more row — its first locale, by the primary
 * key — so no card of every locale is read to keep one. One statement.
 */
export async function networkCards(
  tx: Tx,
  ids: readonly string[],
  locale: string,
  fallback: string,
): Promise<{ targetId: string; kind: Kind; card: unknown }[]> {
  if (ids.length === 0) return [];
  const unique = uuidArray([...new Set(ids)]);
  const result = await tx.execute(sql`
    with pick as (
      select distinct on (m.target_id) m.target_id, m.kind, m.card
        from ${listingReadModels} m
       where m.target_id = any(${unique}) and m.locale in (${locale}, ${fallback})
       order by m.target_id, (m.locale = ${locale}) desc)
    select target_id as "targetId", kind, card from pick
    union all
    select o.target_id, o.kind, o.card
      from unnest(${unique}) as t(id)
      cross join lateral (
        select m.target_id, m.kind, m.card from ${listingReadModels} m
         where m.target_id = t.id order by m.locale limit 1) o
     where not exists (select 1 from pick p where p.target_id = t.id)`);
  return result.rows as { targetId: string; kind: Kind; card: unknown }[];
}
