/**
 * search queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/search` — other modules' tables fail `pnpm check:boundaries`.
 * Read models are written by the search worker only (`withSystem`).
 */

import { randomBytes } from 'node:crypto';
import type { Tx } from '@inmolink/db';
import {
  listingPublicChanges,
  listingPublicCodes,
  listingReadModels,
  listingSearchCommissions,
  listingSearchDevelopments,
  listingSearchDocs,
  readModelQueue,
  searchIndexQueue,
} from '@inmolink/db/schema/search';
import { newId } from '@inmolink/platform/ids';
import { type FieldValue, type Filter, SearchError } from '@inmolink/platform/search';
import { and, eq, getTableColumns, inArray, type SQL, sql } from 'drizzle-orm';
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
const newPublicCode = () => Array.from(randomBytes(8), (b) => CROCKFORD[b & 31]).join('');

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

/** Whether a public code belongs to any target (S7-04: a honeytoken-looking code is real). One unique-index probe. */
export async function publicCodeInUse(tx: Tx, code: string): Promise<boolean> {
  const rows = await tx
    .select({ targetId: listingPublicCodes.targetId })
    .from(listingPublicCodes)
    .where(eq(listingPublicCodes.code, code))
    .limit(1);
  return rows.length > 0;
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

/** A position in the full rebuild's sweep: after the read model `(targetId, locale)` (the primary key). */
export interface SweepPosition {
  targetId: string;
  locale: string;
}

/**
 * The full rebuild walks live targets in id order; a document of `kind` between two consecutive live targets
 * (`after` exclusive, `until` inclusive, null: unbounded) whose target is not one of them has none any more —
 * unless an event rebuilt it since the run's page was read (`updated_at >= since`). Deletes at most `limit` such
 * rows, in primary-key order after `from` (keyset: the primary key range, or `listing_read_models_agency_idx` for
 * one agency), whole targets per chunk (unless `limit` is below a target's locale count), and answers the targets
 * deleted and where the next call starts (`next`, null once the range is done). Bounded because every candidate target takes an advisory lock held until commit: one statement over a
 * range of ~100k stale rows ran out of the shared lock table (53200, S5-01). Call each chunk in its own
 * transaction so its locks are released.
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
    from?: SweepPosition | null;
    limit: number;
  },
): Promise<{ deleted: string[]; next: SweepPosition | null }> {
  const conditions: SQL[] = [
    sql`kind = ${range.kind}`,
    sql`updated_at < ${range.since}`,
    ...(range.from
      ? [sql`(target_id, locale) > (${range.from.targetId}::uuid, ${range.from.locale}::text)`]
      : range.after === null
        ? []
        : [sql`target_id > ${range.after}`]),
    ...(range.until === null ? [] : [sql`target_id <= ${range.until}`]),
    ...(range.live.length === 0 ? [] : [sql`not (target_id = any(${uuidArray(range.live)}))`]),
    ...(range.agencyId === undefined ? [] : [sql`agency_id = ${range.agencyId}`]),
  ];
  const res = await tx.execute(sql`
    with c0 as (
      select target_id, locale from ${listingReadModels} where ${sql.join(conditions, sql` and `)}
       order by target_id, locale limit ${range.limit}),
    -- A full chunk ends before its last target, so a target's locales go in one chunk (counted and logged once).
    cut as (select case when count(*) = ${range.limit} and count(distinct target_id) > 1
                        then (select target_id from c0 order by target_id desc limit 1) end as t
              from c0),
    c as (select c0.target_id, c0.locale from c0, cut where cut.t is null or c0.target_id < cut.t),
    d as (
      delete from ${listingReadModels} r using c
       where r.target_id = c.target_id and r.locale = c.locale
         -- re-checked against a row an event rebuilt meanwhile (it is kept)
         and r.updated_at < ${range.since}
         -- a target a builder holds is being rebuilt (it decides): skip it rather than wait — and never deadlock
         and pg_try_advisory_xact_lock(hashtextextended('read_model:' || c.target_id::text, 0))
      returning r.target_id),
    l as (select target_id, locale from c order by target_id desc, locale desc limit 1)
    select (select count(*) from c0)::int as n, (select target_id::text from l) as "lastTarget",
           (select locale from l) as "lastLocale",
           coalesce((select array_agg(distinct target_id::text) from d), '{}'::text[]) as deleted`);
  const row = res.rows[0] as { n: number; lastTarget: string | null; lastLocale: string | null; deleted: string[] };
  const full = Number(row.n) === range.limit && row.lastTarget !== null && row.lastLocale !== null;
  return {
    deleted: row.deleted,
    next: full ? { targetId: row.lastTarget as string, locale: row.lastLocale as string } : null,
  };
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

/**
 * An agency's own PUBLIC listing documents (portal feeds, S9-02): the detail of each of these targets in the given
 * locales, pinned to the owner agency. One statement (primary key range of the targets). No owner or private fields:
 * the document type has none.
 */
export async function ownListingDetails(tx: Tx, agencyId: string, ids: readonly string[], locales: readonly string[]) {
  if (ids.length === 0 || locales.length === 0) return [];
  return tx
    .select({
      targetId: listingReadModels.targetId,
      locale: listingReadModels.locale,
      detail: listingReadModels.detail,
      updatedAt: listingReadModels.updatedAt,
    })
    .from(listingReadModels)
    .where(
      and(
        eq(listingReadModels.agencyId, agencyId),
        eq(listingReadModels.kind, 'LISTING'),
        eq(listingReadModels.public, true),
        inArray(listingReadModels.targetId, [...ids]),
        inArray(listingReadModels.locale, [...locales]),
      ),
    );
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

/**
 * Queues the index push of one page of an agency's read-model targets (S7-F5: its identity, removed from their
 * indexed text, changed), one kind at a time in target order after `after` (`listing_read_models_agency_idx`
 * order). Answers the page's last target, or null after the last page.
 */
export async function queueAgencyIndexSync(
  tx: Tx,
  page: { agencyId: string; kind: Kind; after: string | null; limit: number },
): Promise<{ queued: number; last: string | null }> {
  const after = page.after === null ? sql`` : sql`and target_id > ${page.after}`;
  const res = await tx.execute<{ target_id: string }>(sql`
    with page as (
      select distinct target_id from ${listingReadModels}
       where agency_id = ${page.agencyId} and kind = ${page.kind} ${after}
       order by target_id limit ${page.limit})
    insert into ${searchIndexQueue} (target_id)
    select target_id from page order by 1
    on conflict (target_id) do update
      set generation = ${searchIndexQueue}.generation + 1, not_before = null
    returning target_id`);
  const ids = res.rows.map((r) => r.target_id).sort();
  return { queued: ids.length, last: ids.length < page.limit ? null : (ids.at(-1) ?? null) };
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

/**
 * Drops the fallback rows of these targets (no read model any more, or no longer PUBLIC). PK probes. Answers the
 * developments of the units dropped (their development rows change, S7-F6).
 */
export async function deleteSearchDocs(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute(sql`delete from ${listingSearchDocs} where target_id = any(${uuidArray(ids)})
    returning case when kind = 'UNIT' then development_id end as development_id`);
  return [
    ...new Set(
      (res.rows as { development_id: string | null }[]).flatMap((r) => (r.development_id ? [r.development_id] : [])),
    ),
  ];
}

/** `ci`: text compared case-insensitively (`lower(col) = lower(value)`, the `lower(ref)` index). */
type ColumnType = 'text' | 'ci' | 'uuid' | 'bigint' | 'int' | 'float8' | 'bool' | 'uuid[]';
type FieldSpec =
  | { column: string; type: ColumnType }
  | { constant: string }
  | { commissionAtLeast: true }
  | { developmentCode: true }
  | { developmentOwnRef: true };

/**
 * Filterable fields of the listings index → fallback columns. `visibility` is a constant (every row is PUBLIC).
 * The network fields (S7-01: sites that show network listings) are null on rows written before they existed, so
 * such a row matches no network filter until a rebuild rewrites it.
 */
const FALLBACK_FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: { column: 'kind::text', type: 'text' },
  // A target by its id (S8-02: the v1 shim's legacy property ids, resolved first): fallback statements only, never sent
  // to the engine (the index's id is its primary key, not a filterable field).
  targetId: { column: 'target_id', type: 'uuid' },
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
  // S7-F11: areas are stored `numeric` (exact) but compared as `float8`. The table is under RLS (`global_read`), where
  // the planner uses statistics only for leakproof operators: `numeric` comparisons are not, so an area band was
  // estimated at 1 row (148k real at 500k) and read through the area index then sorted (467 ms). `float8` comparisons
  // are leakproof; the expression index `area_f8_idx` (and the expression statistics on plot, migration 0104) give
  // them statistics, and the index serves the band and the sort. Same order and the same matches as the engine's.
  areaM2: { column: '(area_m2::float8)', type: 'float8' },
  plotM2: { column: '(plot_m2::float8)', type: 'float8' },
  shareScope: { column: 'share_scope', type: 'text' },
  preferredAgencyIds: { column: 'preferred_agency_ids', type: 'uuid[]' },
  networkHidden: { column: 'network_hidden', type: 'bool' },
  publishedAt: { column: 'published_at', type: 'bigint' },
  // A reference typed in the search box (S7-02: the site's white-label rule decides which reference matches which
  // document, `website.refFilter`).
  ref: { column: 'ref', type: 'ci' },
  // A network listing's site reference (`<prefix>-<code>`, S7-02): codes are upper case, compared as stored.
  publicCode: { column: 'public_code', type: 'text' },
  // A CUSTOM site's minimum commission on network listings (S7-F4): whether the target is in the generated view of
  // those paying at least the transaction's minimum (S7-F10); the value itself is in a table no public role can read.
  commissionBp: { commissionAtLeast: true },
  // A development by its public code (S7-F6: sites name developments `<prefix>-<code>`): its id from the code table
  // in the same statement. The engine has no such field: website search resolves the code first (`website.ts`).
  developmentCode: { developmentCode: true },
  // An own development by its developer's reference (S7-F6; the site's filter keeps its own agencies beside it).
  developmentOwnRef: { developmentOwnRef: true },
};

/**
 * Sortable fields → fallback columns (`nullable`: rows without a value come last in either direction; `type`: the
 * keyset value's cast — the column's own type, so the row comparison stays an index condition).
 */
const FALLBACK_SORTS: Readonly<
  Record<string, { column: string; type: 'bigint' | 'int' | 'float8'; nullable: boolean }>
> = {
  publishedAt: { column: 'published_at', type: 'bigint', nullable: false },
  priceCents: { column: 'price_cents', type: 'bigint', nullable: true },
  beds: { column: 'beds', type: 'int', nullable: true },
  areaM2: { column: '(area_m2::float8)', type: 'float8', nullable: true },
};

const NUMERIC: readonly ColumnType[] = ['bigint', 'int', 'float8'];

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

/** Columns the schema declares `not null` (a negated equality on them needs no `coalesce`), from Drizzle. */
const NOT_NULL_COLUMNS: ReadonlySet<string> = new Set(
  Object.values(getTableColumns(listingSearchDocs))
    .filter((c) => c.notNull)
    .map((c) => c.name),
);
/** A field's column name without its parentheses and cast (`kind::text` → `kind`, `(area_m2::float8)` → `area_m2`). */
const bareColumn = (column: string) => column.replace(/^\((.*)\)$/, '$1').replace(/::[a-z0-9_]+$/, '');

/**
 * S7-F9: the network rule's negations (`not ownerAgencyId = self`, `not networkHidden = true`) in forms the planner
 * estimates from the column statistics — `owner_agency_id <> $1`, `network_hidden is not true` — with the same
 * meaning as `not coalesce(…, false)`. The opaque form got a default selectivity, so a network filter was estimated
 * at ~1 % of its real rows and a sitemap page took a bitmap over half the network then a sort (56 ms at 100k rows,
 * growing with the network) instead of the code index walked to `limit + 1` (3 ms). Null: no such form.
 */
function negation(filter: Filter): SQL | null {
  if (filter.op !== 'eq' && filter.op !== 'in') return null;
  const f = FALLBACK_FIELDS[filter.field];
  if (!f || !('column' in f) || f.type === 'uuid[]') return null;
  const col = sql.raw(f.column);
  if (f.type === 'bool' && filter.op === 'eq' && typeof filter.value === 'boolean') {
    return filter.value ? sql`${col} is not true` : sql`${col} is not false`;
  }
  if (!NOT_NULL_COLUMNS.has(bareColumn(f.column)) || f.type === 'ci') return null;
  if (filter.op === 'eq') return sql`${col} <> ${paramOf(f.type, filter.value)}`;
  if (filter.values.length === 0) throw new SearchError('empty in');
  return sql`${col} <> all(${typedArray(filter.values, f.type)})`;
}

/**
 * The engine-neutral filter → a SQL condition on `listing_search_docs`, with the engine's semantics: an array field
 * equals a value when it holds it (`@>`) and is `in` values when it shares one (`&&`); a range never matches a null.
 * Values are always parameters; column names come from the map above, never from the caller.
 *
 * `rangesAsFilters`: numeric ranges compared as `(…) is true` — same rows and statistics, never an index condition
 * (`fallbackSearchSql`'s capped match set when a location narrows it, S7-F11).
 */
export function fallbackCondition(filter: Filter, opts: { rangesAsFilters?: boolean } = {}): SQL {
  switch (filter.op) {
    case 'and':
    case 'or': {
      if (filter.filters.length === 0) throw new SearchError(`empty ${filter.op}`);
      return sql`(${sql.join(
        filter.filters.map((f) => fallbackCondition(f, opts)),
        sql.raw(filter.op === 'and' ? ' and ' : ' or '),
      )})`;
    }
    case 'not':
      return negation(filter.filter) ?? sql`(not coalesce(${fallbackCondition(filter.filter, opts)}, false))`;
    case 'eq': {
      const f = fieldOf(filter.field);
      if ('constant' in f) return filter.value === f.constant ? sql`true` : sql`false`;
      if ('commissionAtLeast' in f) throw new SearchError(`field supports only a minimum: ${filter.field}`);
      if ('developmentCode' in f) {
        return sql`development_id = (select pc.target_id from ${listingPublicCodes} pc where pc.code = ${String(filter.value)})`;
      }
      if ('developmentOwnRef' in f) {
        return sql`development_id in (select dr.development_id from ${listingSearchDevelopments} dr
                                       where lower(dr.ref) = lower(${String(filter.value)}))`;
      }
      if (f.type === 'uuid[]') return sql`${sql.raw(f.column)} @> ${typedArray([filter.value], f.type)}`;
      if (f.type === 'ci') return sql`lower(${sql.raw(f.column)}) = lower(${String(filter.value)})`;
      return sql`${sql.raw(f.column)} = ${paramOf(f.type, filter.value)}`;
    }
    case 'in': {
      if (filter.values.length === 0) throw new SearchError('empty in');
      const f = fieldOf(filter.field);
      if ('constant' in f) return filter.values.includes(f.constant) ? sql`true` : sql`false`;
      if ('commissionAtLeast' in f || 'developmentCode' in f || 'developmentOwnRef' in f) {
        throw new SearchError(`field supports only equality: ${filter.field}`);
      }
      if (f.type === 'uuid[]') return sql`${sql.raw(f.column)} && ${typedArray(filter.values, f.type)}`;
      if (f.type === 'ci') {
        return sql`lower(${sql.raw(f.column)}) in (${sql.join(
          filter.values.map((v) => sql`lower(${String(v)})`),
          sql`, `,
        )})`;
      }
      if (filter.field === 'status' && filter.values.includes('ACTIVE')) {
        // S7-F11: a status set with ACTIVE matches most targets (85 % in the scale seed): a filter, never an index
        // condition. As one, PG 18's skip scan over `transaction_idx` (transaction type, status) offered a 425k-row
        // bitmap to AND with a selective one; whether the planner took it was a near tie that flipped with one page of
        // `listing_search_commissions` not all-visible (a one-row index-only probe then costs a heap page: 1.56 →
        // 2.66) — CI's and production's state, not a settled test table — and cost ~10 ms (shape 13). `is true` keeps
        // the statistics (leakproof under RLS, same answer: the column is not null). A set without ACTIVE is selective
        // and stays indexable (reserved units network-wide).
        return sql`(${sql.raw(f.column)} = any(${typedArray(filter.values, f.type)})) is true`;
      }
      return sql`${sql.raw(f.column)} = any(${typedArray(filter.values, f.type)})`;
    }
    case 'range': {
      const f = fieldOf(filter.field);
      if ('commissionAtLeast' in f) {
        // Only a minimum (a missing commission matches none). S7-F10: an index probe per candidate into the generated
        // view of the targets paying at least the transaction's minimum (`withPublicRead({ minCommissionBp })`), not a
        // SECURITY DEFINER call per row (~10 µs each: shape 13 and `/v2/developments` on a commission site). `floor_bp`
        // must be this filter's minimum: a transaction set for another one (or none) answers no row, never wrong ones.
        // `offset 0` keeps it a per-row probe: never a semi-join or a hashed subplan over every paying target. The
        // unqualified `target_id` is the row's (the view's columns are named `floor_*`).
        if (filter.gte === undefined || filter.lte !== undefined) throw new SearchError('commission: a minimum only');
        return sql`exists (select 1 from public.search_commission_floor cf
          where cf.floor_target_id = target_id and cf.floor_bp = ${Math.trunc(finite(filter.gte))}::int offset 0)`;
      }
      if ('constant' in f || 'developmentCode' in f || 'developmentOwnRef' in f || !NUMERIC.includes(f.type))
        throw new SearchError(`field is not comparable: ${filter.field}`);
      // `is not null` first: a range never matches a null — `requiresValue` relies on it (S7-F9, unit-tested).
      const parts: SQL[] = [sql`${sql.raw(f.column)} is not null`];
      if (filter.gte !== undefined) parts.push(sql`${sql.raw(f.column)} >= ${finite(filter.gte)}`);
      if (filter.lte !== undefined) parts.push(sql`${sql.raw(f.column)} <= ${finite(filter.lte)}`);
      if (opts.rangesAsFilters) return sql`((${sql.join(parts, sql` and `)}) is true)`;
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

/**
 * Whether every row matching `filter` has a value in `field` (S7-F9): a range, an `eq` or an `in` on it is never true
 * for a null (`fallbackCondition`: a range starts with `col is not null`, `=` / `= any` are null on a null), so an
 * `and` holding one, or an `or` whose every branch does, rules nulls out. Relies on that compiler; the unit test
 * `[S7-F9] requiresValue holds because…` pins it. Conservative: `not`, geo and anything else answer false (the null
 * phase is kept).
 */
export function requiresValue(filter: Filter, field: string): boolean {
  switch (filter.op) {
    case 'and':
      return filter.filters.some((f) => requiresValue(f, field));
    case 'or':
      return filter.filters.length > 0 && filter.filters.every((f) => requiresValue(f, field));
    case 'range':
    case 'eq':
    case 'in':
      return filter.field === field;
    default:
      return false;
  }
}

/** Whether every row matching `filter` is in given locations (a location condition on its `and` spine). */
function hasLocation(filter: Filter): boolean {
  if (filter.op === 'and') return filter.filters.some(hasLocation);
  return (filter.op === 'eq' || filter.op === 'in') && filter.field === 'locationIds';
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
    const keyset = q.after
      ? sql`and (${col}, target_id) ${cmp} (${q.after.value}::${sql.raw(sort.type)}, ${q.after.id}::uuid)`
      : sql``;
    branches.push(sql`(select target_id, ${col}::float8 as k, 0 as phase from ${listingSearchDocs}
       where ${where} ${sort.nullable ? sql`and ${col} is not null` : sql``} ${keyset}
       order by ${col} ${dir}, target_id ${dir} limit ${take})`);
  }
  if (sort.nullable) {
    const keyset = q.after?.phase === 1 ? sql`and target_id ${cmp} ${q.after.id}::uuid` : sql``;
    // S7-F9: a filter that needs a value in the sort column (a price band sorted by price) has no rows without one.
    // The planner does not see `price_cents is not null and price_cents is null` as a contradiction: it walked the
    // whole table in id order for the 25 rows that cannot exist (13–1,055 ms at ~800k rows). A constant false
    // instead is a one-time filter — no scan.
    const nulls = requiresValue(q.filter, q.sort.field) ? sql`false` : sql`${where} and ${col} is null ${keyset}`;
    // Ordered by the sort column too (all null here, so the order is the id's): the planner then walks the sort index's
    // null entries in id order and stops at `limit + 1` (S7-F9 review: ordered by id alone, it read a whole area band
    // through the area index and sorted — 109k rows, 205 ms — for the null-price rows of a network site).
    branches.push(sql`(select target_id, null::float8 as k, 1 as phase from ${listingSearchDocs}
       where ${nulls}
       order by ${col} ${dir}, target_id ${dir} limit ${take})`);
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
  // S7-F11 (CI runs 39758344176, 39766144207): with a location, `m` reads the location's bitmap and filters the ranges.
  // The planner builds one bitmap per scan by total cost, blind to `m`'s limit, so a price band (~200k entries at 500k
  // rows) ANDed to a city's 8k won by total cost on a fresh index and cost 16 ms up front (26 ms on CI against 9 ms):
  // a near tie that flipped with the index's size. A location matches thousands of rows at most per city and `m`
  // stops at the cap; the index-ordered branches below keep the ranges as index conditions (a band sorted by price).
  const matchWhere = hasLocation(q.filter) ? fallbackCondition(q.filter, { rangesAsFilters: true }) : where;
  return sql`
    with m as materialized (
      select target_id, ${col}::float8 as k from ${listingSearchDocs} where ${matchWhere} limit ${q.countCap + 1}),
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

// ---------------------------------------------------------------------------------------------------------------
// Commission of PUBLIC targets (S7-F4)

/**
 * Brings the commission rows of these targets (one rebuild's) in line with `wanted` (the PUBLIC ones that have a
 * known commission): two statements; a row is written only when its value changed. Answers the targets that changed.
 */
export async function syncCommissions(
  tx: Tx,
  scope: readonly string[],
  wanted: ReadonlyMap<string, number>,
): Promise<string[]> {
  const ids = [...wanted.keys()];
  const upserted =
    ids.length === 0
      ? []
      : (
          await tx.execute(sql`
            insert into ${listingSearchCommissions} as c (target_id, commission_bp)
            select * from unnest(${uuidArray(ids)}, ${sql`array[${sql.join(
              ids.map((id) => sql`${wanted.get(id)}`),
              sql`, `,
            )}]::int[]`})
            on conflict (target_id) do update set commission_bp = excluded.commission_bp
              where c.commission_bp <> excluded.commission_bp
            returning c.target_id as id`)
        ).rows;
  const removed =
    scope.length === 0
      ? []
      : (
          await tx.execute(sql`
            delete from ${listingSearchCommissions}
             where target_id = any(${uuidArray(scope)}) and target_id <> all(${uuidArray(ids)})
            returning target_id as id`)
        ).rows;
  return [...upserted, ...removed].map((r) => (r as { id: string }).id);
}

// ---------------------------------------------------------------------------------------------------------------
// Website API v2 (S7-03): public change log, hydration and lookups. Public paths read as `app_public`.

/** A change-log row: a target whose public website view may have changed, and who could have seen it. */
export interface PublicChangeRow {
  targetId: string;
  kind: Kind;
  ownerAgencyId: string;
  ref: string;
  /** Shared with every agency (or a unit) before or after the change. */
  sharedAll: boolean;
  /** Else: the agencies its owner prefers, before and after. */
  preferredAgencyIds: string[] | null;
}

/** Appends change-log rows (the writing transaction's id is the column default). One statement. */
export async function logPublicChanges(tx: Tx, rows: readonly PublicChangeRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(listingPublicChanges).values(
    rows.map((r) => ({
      targetId: r.targetId,
      kind: r.kind,
      ownerAgencyId: r.ownerAgencyId,
      ref: r.ref,
      sharedAll: r.sharedAll,
      preferredAgencyIds: r.preferredAgencyIds,
    })),
  );
}

/** A fallback row as the change log needs it: the target was PUBLIC at its last refresh, with this sharing. */
export interface PublicRowBefore {
  targetId: string;
  kind: Kind;
  ownerAgencyId: string;
  ref: string;
  shareScope: string | null;
  preferredAgencyIds: string[] | null;
  /** S7-06: its development (a unit leaving the public set purges the development's edge copies). */
  developmentId: string | null;
  /** S8-F1: whether network sites could show it (a shown status, not hidden from the network). */
  status: string;
  networkHidden: boolean;
}

/** These targets' fallback rows (PUBLIC targets as of their last refresh), for the change log. PK probes. */
export async function publicRowsOf(tx: Tx, ids: readonly string[]): Promise<PublicRowBefore[]> {
  if (ids.length === 0) return [];
  return tx
    .select({
      targetId: listingSearchDocs.targetId,
      kind: listingSearchDocs.kind,
      ownerAgencyId: listingSearchDocs.ownerAgencyId,
      ref: listingSearchDocs.ref,
      shareScope: listingSearchDocs.shareScope,
      preferredAgencyIds: listingSearchDocs.preferredAgencyIds,
      developmentId: listingSearchDocs.developmentId,
      status: listingSearchDocs.status,
      // Null on rows from before the column: not hidden.
      networkHidden: sql<boolean>`coalesce(${listingSearchDocs.networkHidden}, false)`,
    })
    .from(listingSearchDocs)
    .where(inArray(listingSearchDocs.targetId, [...new Set(ids)]));
}

/** A position in the change log: after the row `(tx, seq)` (`tx` an xid8 as text). */
export interface ChangePosition {
  tx: string;
  seq: number;
}

export interface ChangeLogRow {
  tx: string;
  seq: number;
  targetId: string;
  kind: Kind;
  ownerAgencyId: string;
  ref: string;
  publicCode: string | null;
  changedAt: Date;
}

/** Whose changes a site's feed reads: one owner's (own-only sites), or those a network site could have shown. */
export type ChangeAudience = { ownerAgencyId: string } | { networkOf: string };

/**
 * One page of the change log after `after`, in `(tx_id, seq)` order, only rows of transactions below the snapshot's
 * `xmin` (all finished: no row can still appear before the page's last one). An own-only site reads its agency's rows
 * (`_owner_idx`); a network site reads its own and those of targets shared with it before or after the change
 * (`_tx_idx`) — never other agencies' activity it could not show. Also answers the snapshot's `xmin` and how long
 * the oldest committed row behind it has waited (`heldSeconds`: a long transaction holds every feed back). One
 * statement.
 */
export async function publicChangesPage(
  tx: Tx,
  q: { after: ChangePosition; audience: ChangeAudience; limit: number },
): Promise<{ rows: ChangeLogRow[]; horizon: string; heldSeconds: number }> {
  const who =
    'ownerAgencyId' in q.audience
      ? sql`and c.owner_agency_id = ${q.audience.ownerAgencyId}::uuid`
      : sql`and (c.owner_agency_id = ${q.audience.networkOf}::uuid or c.shared_all
                 or c.preferred_agency_ids @> array[${q.audience.networkOf}::uuid])`;
  // `held`: the rows of transactions still in flight (usually none), by `tx_idx` from the horizon, capped at 1,000
  // (S7-08 load test: as a join filter against `h` it was a sequential scan of the whole log on every request).
  const res = await tx.execute(sql`
    with h as (select pg_snapshot_xmin(pg_current_snapshot()) as xmin),
    held as (select coalesce(extract(epoch from now() - min(w.changed_at)), 0)::float8 as s
               from (select w.changed_at from ${listingPublicChanges} w
                      where w.tx_id >= (select xmin from h) order by w.tx_id, w.seq limit 1000) w)
    select h.xmin::text as horizon, held.s as held, r.* from h cross join held
      left join lateral (
        select c.tx_id::text as tx, c.seq, c.target_id as "targetId", c.kind, c.owner_agency_id as "ownerAgencyId",
               c.ref, c.changed_at as "changedAt", p.code as "publicCode"
          from ${listingPublicChanges} c
          left join ${listingPublicCodes} p on p.target_id = c.target_id
         where c.tx_id < h.xmin and (c.tx_id, c.seq) > (${q.after.tx}::xid8, ${q.after.seq}::bigint) ${who}
         order by c.tx_id, c.seq
         limit ${q.limit}) r on true`);
  const rows = res.rows as (Omit<ChangeLogRow, 'changedAt' | 'seq'> & {
    horizon: string;
    held: number | string;
    seq: string | number | null;
    changedAt: string | Date | null;
  })[];
  return {
    horizon: rows[0]?.horizon ?? '0',
    heldSeconds: Math.max(0, Number(rows[0]?.held ?? 0)),
    rows: rows
      .filter((r) => r.seq !== null)
      .map((r) => ({
        tx: r.tx,
        seq: Number(r.seq),
        targetId: r.targetId,
        kind: r.kind,
        ownerAgencyId: r.ownerAgencyId,
        ref: r.ref,
        publicCode: r.publicCode,
        changedAt: new Date(r.changedAt as string),
      })),
  };
}

/**
 * Where `?since=` starts (S7-03 review): `changed_at` is the writing transaction's start, but pages go by transaction
 * id, and a transaction that started later may have taken its id earlier. So the start is the smallest `(tx_id, seq)`
 * among rows changed within `margin` of the first change at or after `since` (from `since - margin`): a transaction
 * would need to wait longer than the margin before its first write to fall before it. Changes up to `margin` before
 * `since` may be included; the cursor is exact from there. Nothing changed since then: the snapshot's `xmin`. One
 * statement (`listing_public_changes_changed_idx`, a window of `2 × margin` rows sorted).
 */
export async function publicChangesStart(tx: Tx, since: Date, marginSeconds: number): Promise<ChangePosition> {
  const at = sql`${since.toISOString()}::timestamptz`;
  const margin = sql`make_interval(secs => ${marginSeconds})`;
  // The window is a range on `changed_idx` with both bounds from `f` (a lateral parameter), then its smallest position
  // (S7-08 load test + perf audit: with the sort and limit in one step the planner walked `tx_idx` from the log's
  // start; with an upper bound unknown at plan time it chose a sequential scan for an old `since`). The window starts
  // `margin` before the first change at or after `since` (nothing changed between `since` and it).
  const res = await tx.execute(sql`
    with f as (select c.changed_at from ${listingPublicChanges} c where c.changed_at >= ${at}
                order by c.changed_at limit 1),
    s as (select w.tx_id, w.seq from f cross join lateral (
            select c.tx_id, c.seq from ${listingPublicChanges} c
             where c.changed_at >= greatest(${at}, f.changed_at) - ${margin}
               and c.changed_at < f.changed_at + ${margin}
             offset 0) w
           order by w.tx_id, w.seq limit 1)
    select coalesce((select tx_id::text from s), pg_snapshot_xmin(pg_current_snapshot())::text) as tx,
           coalesce((select seq - 1 from s), -1) as seq`);
  const row = res.rows[0] as { tx: string; seq: string | number };
  return { tx: row.tx, seq: Number(row.seq) };
}

/** Of these targets, those the site's filter matches now. One statement by primary key. */
export async function matchingTargets(tx: Tx, filter: Filter, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await tx.execute(sql`
    select target_id as "targetId" from ${listingSearchDocs}
     where target_id = any(${uuidArray([...new Set(ids)])}) and ${fallbackCondition(filter)}`);
  return new Set((res.rows as { targetId: string }[]).map((r) => r.targetId));
}

/** Drops change-log rows older than `before`, at most `limit` (the oldest). Answers how many went. */
export async function prunePublicChanges(tx: Tx, before: Date, limit: number): Promise<number> {
  const res = await tx.execute(sql`
    delete from ${listingPublicChanges} where seq in (
      select seq from ${listingPublicChanges} where changed_at < ${before.toISOString()}::timestamptz
       order by changed_at limit ${limit})`);
  return res.rowCount ?? 0;
}

/** A public document read for a site: the read model in the best locale, its owner and public code. */
export interface PublicDocRow {
  targetId: string;
  kind: Kind;
  ownerAgencyId: string;
  publicCode: string | null;
  /**
   * The public code of the document's development (S7-F6: sites show it as the development's reference), null when
   * it has none (no development, or no code yet). Not read for sitemap rows.
   */
  developmentCode: string | null;
  /**
   * The developer's own reference of the document's development (S7-F6, its development row): the owner's sites show
   * it, the white-label sanitizer removes it from network text. Null without one.
   */
  developmentOwnRef: string | null;
  doc: unknown;
  updatedAt: Date;
  /** The document's locale (`publicDocs` only, S7-07): the best one may not be the one asked for. */
  locale?: string;
}

/**
 * A target's best locale among its public read models: `locale`, then `fallback`, then the first. From the primary
 * key only (no document is read to be dropped).
 */
const bestLocale = (target: SQL, locale: string, fallback: string) => sql`(
  select b.locale from ${listingReadModels} b where b.target_id = ${target} and b.public
   order by (b.locale = ${locale}) desc, (b.locale = ${fallback}) desc, b.locale limit 1)`;

const docRows = (rows: unknown[]): PublicDocRow[] =>
  (rows as (Omit<PublicDocRow, 'updatedAt'> & { updatedAt: string | Date })[]).map((r) => ({
    ...r,
    updatedAt: new Date(r.updatedAt),
  }));

/**
 * Public documents of these targets (website search hydration, S7-03): `card` or `detail` in the best locale, with
 * the owner and public code. One statement; targets without a public read model are absent.
 */
export async function publicDocs(
  tx: Tx,
  ids: readonly string[],
  part: 'card' | 'detail',
  locale: string,
  fallback: string,
): Promise<PublicDocRow[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute(sql`
    select m.target_id as "targetId", m.kind, m.agency_id as "ownerAgencyId", m.${sql.raw(part)} as doc,
           m.updated_at as "updatedAt", c.code as "publicCode", dc.code as "developmentCode",
           dg.ref as "developmentOwnRef", m.locale
      from unnest(${uuidArray([...new Set(ids)])}) as t(id)
      join ${listingReadModels} m on m.target_id = t.id and m.locale = ${bestLocale(sql`t.id`, locale, fallback)}
      left join ${listingPublicCodes} c on c.target_id = t.id
      left join ${listingPublicCodes} dc on dc.target_id = m.development_id
      left join ${listingSearchDevelopments} dg on dg.development_id = m.development_id`);
  return docRows(res.rows);
}

/**
 * The public detail a site's reference names (`/v2/listings/{ref}`): the first target the site's filter (with its
 * reference condition) matches, in the best locale. One statement.
 */
export async function publicDetailWhere(
  tx: Tx,
  filter: Filter,
  locale: string,
  fallback: string,
): Promise<PublicDocRow | null> {
  const res = await tx.execute(sql`
    with t as (select target_id, public_code from ${listingSearchDocs} where ${fallbackCondition(filter)}
                order by kind, target_id limit 1)
    select m.target_id as "targetId", m.kind, m.agency_id as "ownerAgencyId", m.detail as doc,
           m.updated_at as "updatedAt", t.public_code as "publicCode", dc.code as "developmentCode",
           dg.ref as "developmentOwnRef"
      from t join ${listingReadModels} m on m.target_id = t.target_id
       and m.locale = ${bestLocale(sql`t.target_id`, locale, fallback)}
      left join ${listingPublicCodes} dc on dc.target_id = m.development_id
      left join ${listingSearchDevelopments} dg on dg.development_id = m.development_id`);
  return docRows(res.rows)[0] ?? null;
}

/**
 * One sitemap page (S7-03): the site's matching targets in public-code order after the code `after` (codes are shown
 * anyway; ids are not), each with its card in the best locale (the serializer makes the shown reference and slug);
 * `limit + 1` rows (an extra one: a next page). Targets without a code yet (written before S7-02, until the deploy
 * rebuild) are left out. One statement.
 */
export async function sitemapPage(
  tx: Tx,
  q: {
    filter: Filter;
    /** The site's own agencies: their branch walks `listing_search_docs_owner_code_idx`. */
    own: readonly string[];
    /** Other agencies' documents too (network sites): a branch of its own on `listing_search_docs_public_code_idx`. */
    network: boolean;
    after?: string;
    limit: number;
    locale: string;
    fallback: string;
    /**
     * `none` (S7-07, the XML feed reads details per locale itself): codes and ids only, no document. `sitemap`
     * (S7-F10 review): the card's fields a sitemap entry shows (kind, id, ref, slug, title, development) — a fraction of
     * the card's JSON to send and parse for 500 entries.
     */
    part?: 'card' | 'none' | 'sitemap';
  },
): Promise<PublicDocRow[]> {
  const after = q.after ? sql`and public_code > ${q.after}` : sql``;
  const where = fallbackCondition(q.filter);
  const take = q.limit + 1;
  const branches: SQL[] = [];
  if (q.own.length > 0) {
    branches.push(sql`(select target_id, public_code from ${listingSearchDocs}
       where owner_agency_id = any(${uuidArray(q.own)}) and ${where} and public_code is not null ${after}
       order by public_code limit ${take})`);
  }
  if (q.network) {
    const others = q.own.length > 0 ? sql`and owner_agency_id <> all(${uuidArray(q.own)})` : sql``;
    branches.push(sql`(select target_id, public_code from ${listingSearchDocs}
       where ${where} ${others} and public_code is not null ${after} order by public_code limit ${take})`);
  }
  if (branches.length === 0) return [];
  const res = await tx.execute(sql`
    with s as (select * from (${sql.join(branches, sql` union all `)}) u order by public_code limit ${take})
    select m.target_id as "targetId", m.kind, m.agency_id as "ownerAgencyId", s.public_code as "publicCode",
           null::text as "developmentCode", null::text as "developmentOwnRef",
           ${
             q.part === 'none'
               ? sql`null::jsonb`
               : q.part === 'sitemap'
                 ? sql`jsonb_build_object('kind', m.card -> 'kind', 'id', m.card -> 'id', 'ref', m.card -> 'ref',
                     'slug', m.card -> 'slug', 'title', m.card -> 'title', 'development', m.card -> 'development')`
                 : sql`m.card`
           } as doc, m.updated_at as "updatedAt"
      from s join ${listingReadModels} m on m.target_id = s.target_id
       and m.locale = ${bestLocale(sql`s.target_id`, q.locale, q.fallback)}
     order by s.public_code`);
  return docRows(res.rows);
}

// ── Website developments (S7-F6) ───────────────────────────────────────────────────────────────────────────────

/**
 * Brings the development rows (`listing_search_developments`) of these developments up to date from their units'
 * fallback rows: the aggregates over the AVAILABLE and RESERVED units, the unit carrying the texts, the owner and
 * place; no row when none is left. `refs`: the developers' own references from the documents just built (a row keeps
 * its reference otherwise). One statement.
 */
export async function refreshDevelopments(
  tx: Tx,
  ids: readonly string[],
  refs: ReadonlyMap<string, string>,
): Promise<void> {
  if (ids.length === 0) return;
  const unique = uuidArray([...new Set(ids)]);
  const known = [...refs.entries()];
  const refRows =
    known.length === 0
      ? sql`select null::uuid as id, null::text as ref where false`
      : sql`select * from unnest(${uuidArray(known.map(([id]) => id))}, ${sql`array[${sql.join(
          known.map(([, ref]) => sql`${ref}`),
          sql`, `,
        )}]::text[]`}) as r(id, ref)`;
  await tx.execute(sql`
    with agg as (
      select s.development_id as id, count(*)::int as units,
             (count(*) filter (where s.status = 'AVAILABLE'))::int as available,
             (count(*) filter (where s.status = 'RESERVED'))::int as reserved,
             min(s.price_cents) filter (where s.status = 'AVAILABLE') as price_min,
             max(s.price_cents) filter (where s.status = 'AVAILABLE') as price_max,
             min(s.beds) as beds_min, max(s.beds) as beds_max,
             (array_agg(s.target_id order by s.target_id))[1] as rep
        from ${listingSearchDocs} s
       where s.development_id = any(${unique}) and s.kind = 'UNIT' and s.status in ('AVAILABLE', 'RESERVED')
       group by s.development_id),
    refs as (${refRows}),
    up as (
      insert into ${listingSearchDevelopments} as g (development_id, owner_agency_id, ref, location_ids, units,
             available, reserved, price_min_cents, price_max_cents, beds_min, beds_max, rep_target_id, updated_at)
      select agg.id, r.owner_agency_id, refs.ref, r.location_ids, agg.units, agg.available, agg.reserved,
             agg.price_min, agg.price_max, agg.beds_min, agg.beds_max, agg.rep, now()
        from agg join ${listingSearchDocs} r on r.target_id = agg.rep
        left join refs on refs.id = agg.id
      on conflict (development_id) do update set
        owner_agency_id = excluded.owner_agency_id, ref = coalesce(excluded.ref, g.ref),
        location_ids = excluded.location_ids, units = excluded.units, available = excluded.available,
        reserved = excluded.reserved, price_min_cents = excluded.price_min_cents,
        price_max_cents = excluded.price_max_cents, beds_min = excluded.beds_min, beds_max = excluded.beds_max,
        rep_target_id = excluded.rep_target_id, updated_at = now()
      returning g.development_id)
    delete from ${listingSearchDevelopments} d
     where d.development_id = any(${unique}) and not exists (select 1 from agg where agg.id = d.development_id)`);
}

/**
 * A development as a site shows it (S7-F6): its row's aggregates (over all its AVAILABLE and RESERVED units) and the
 * representative unit's public document (`card` or `detail`, best locale), which carries the development's texts,
 * status and place.
 */
export interface DevelopmentRow {
  developmentId: string;
  /** The development's public code: its reference on another agency's site is `<prefix>-<code>`. */
  code: string;
  /** The developer's own reference (the owner's sites show it; never another agency's). */
  ownRef: string | null;
  ownerAgencyId: string;
  total: number;
  available: number;
  reserved: number;
  priceMin: number | null;
  priceMax: number | null;
  bedsMin: number | null;
  bedsMax: number | null;
  doc: unknown;
}

/**
 * Which developments a site may show, on the development row `g` (S7-F6): its own agencies' and — network sites —
 * other agencies' (units are shared with every agency and never freshness-hidden, so the owner decides), anywhere
 * under every set of locations (a development's units share its place); with a public code (addressable). The
 * unit-level rules (statuses, types, price band, minimum commission) are `member`.
 */
export interface DevelopmentScope {
  /** The site's own agencies; null: every agency's. */
  own: readonly string[] | null;
  /** Other agencies' developments too. */
  network: boolean;
  /** Each: anywhere under any of these locations. */
  locationSets: readonly (readonly string[])[];
}

/** A site's reference to a development: its own reference (own developments) and/or a public code (network ones). */
export interface DevelopmentRefMatch {
  ownRef: string | null;
  code: string | null;
}

function scopeSql(scope: DevelopmentScope): SQL {
  const parts: SQL[] = [sql`exists (select 1 from ${listingPublicCodes} pc where pc.target_id = g.development_id)`];
  if (scope.own !== null) {
    const whose: SQL[] = [];
    if (scope.own.length > 0) whose.push(sql`g.owner_agency_id = any(${uuidArray(scope.own)})`);
    if (scope.network) {
      whose.push(scope.own.length > 0 ? sql`g.owner_agency_id <> all(${uuidArray(scope.own)})` : sql`true`);
    }
    parts.push(whose.length === 0 ? sql`false` : sql`(${sql.join(whose, sql` or `)})`);
  }
  for (const set of scope.locationSets) parts.push(sql`g.location_ids && ${uuidArray(set)}`);
  return sql.join(parts, sql` and `);
}

/**
 * One unit of the development matches the site's unit filter. Unqualified columns inside resolve to the units' rows
 * (the innermost table), so the filter compiled for `listing_search_docs` applies as it is.
 *
 * S7-F10: `offset 0` keeps it a probe of each candidate development's units (`listing_search_docs_development_idx`,
 * stopping at the first match) under the development walk, never a semi-join that first evaluates the filter on every
 * unit in the site's places. The planner cannot price the unit filter — `listing_search_docs` is under RLS, so its
 * non-leakproof comparisons (`&&`, `@>`, `kind::text`) get no statistics — and estimated 7 of 505 developments
 * matching a 3 % minimum commission network-wide: it hashed all 17k candidate units (17k commission probes, 60 ms)
 * where 26 development probes answer the page (1 ms).
 */
const memberSql = (where: SQL) =>
  sql`exists (select 1 from ${listingSearchDocs} where development_id = g.development_id and ${where} offset 0)`;

function refMatchSql(scope: DevelopmentScope, ref: DevelopmentRefMatch): SQL {
  const own = scope.own ?? [];
  const branches: SQL[] = [];
  if (ref.ownRef !== null && (scope.own === null || own.length > 0)) {
    branches.push(
      scope.own === null
        ? sql`lower(g.ref) = lower(${ref.ownRef})`
        : sql`(g.owner_agency_id = any(${uuidArray(own)}) and lower(g.ref) = lower(${ref.ownRef}))`,
    );
  }
  if (ref.code !== null) {
    const notOwn = own.length > 0 ? sql`g.owner_agency_id <> all(${uuidArray(own)}) and` : sql``;
    branches.push(
      sql`(${notOwn} g.development_id = (select pk.target_id from ${listingPublicCodes} pk where pk.code = ${ref.code}))`,
    );
  }
  return branches.length === 0 ? sql`false` : sql`(${sql.join(branches, sql` or `)})`;
}

/** The development rows of `d(id)` with their representative document, newest first. */
function developmentRows(part: 'card' | 'detail', locale: string, fallback: string): SQL {
  return sql`
    select g.development_id as "developmentId", dc.code, g.ref as "ownRef", g.owner_agency_id as "ownerAgencyId",
           g.units as total, g.available, g.reserved, g.price_min_cents as "priceMin", g.price_max_cents as "priceMax",
           g.beds_min as "bedsMin", g.beds_max as "bedsMax", r.${sql.raw(part)} as doc
      from d
      join ${listingSearchDevelopments} g on g.development_id = d.id
      join ${listingPublicCodes} dc on dc.target_id = g.development_id
      join ${listingReadModels} r on r.target_id = g.rep_target_id
       and r.locale = ${bestLocale(sql`g.rep_target_id`, locale, fallback)}
     order by g.development_id desc`;
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const developmentRowsOf = (rows: unknown[]): DevelopmentRow[] =>
  (rows as Record<string, unknown>[]).map((r) => ({
    developmentId: r.developmentId as string,
    code: r.code as string,
    ownRef: (r.ownRef as string | null) ?? null,
    ownerAgencyId: r.ownerAgencyId as string,
    total: Number(r.total),
    available: Number(r.available),
    reserved: Number(r.reserved),
    priceMin: numOrNull(r.priceMin),
    priceMax: numOrNull(r.priceMax),
    bedsMin: numOrNull(r.bedsMin),
    bedsMax: numOrNull(r.bedsMax),
    doc: r.doc,
  }));

/**
 * One page of the site's developments (`/v2/developments`), newest first (UUIDv7 ids), after the development coded
 * `after`: development rows in the site's scope with one unit matching its unit filter; `limit + 1` rows (an extra
 * one: a next page). One statement over the development rows (an own site's by its owner index, a regional one's by
 * the locations index, a broad one newest-first by the primary key) — no unit aggregated per request.
 */
export async function developmentPage(
  tx: Tx,
  q: {
    filter: Filter;
    scope: DevelopmentScope;
    after?: string;
    limit: number;
    locale: string;
    fallback: string;
  },
): Promise<DevelopmentRow[]> {
  const after = q.after
    ? sql`and g.development_id < (select pa.target_id from ${listingPublicCodes} pa where pa.code = ${q.after})`
    : sql``;
  const res = await tx.execute(sql`
    with d as (
      select g.development_id as id from ${listingSearchDevelopments} g
       where ${scopeSql(q.scope)} ${after} and ${memberSql(fallbackCondition(q.filter))}
       order by g.development_id desc limit ${q.limit + 1})
    ${developmentRows('card', q.locale, q.fallback)}`);
  return developmentRowsOf(res.rows);
}

/** The development a site reference names, as the site shows it (`/v2/developments/{ref}`); null: not on the site. */
export async function developmentByRef(
  tx: Tx,
  q: { filter: Filter; scope: DevelopmentScope; ref: DevelopmentRefMatch; locale: string; fallback: string },
): Promise<DevelopmentRow | null> {
  const res = await tx.execute(sql`
    with d as (
      select g.development_id as id from ${listingSearchDevelopments} g
       where ${refMatchSql(q.scope, q.ref)} and ${scopeSql(q.scope)} and ${memberSql(fallbackCondition(q.filter))}
       limit 1)
    ${developmentRows('detail', q.locale, q.fallback)}`);
  return developmentRowsOf(res.rows)[0] ?? null;
}

/** One unit-table page and whether the development is on the site, and the cursor's unit is one of its units. */
export interface DevelopmentUnitsPage {
  /** The site shows the development. */
  found: boolean;
  /** The cursor's unit is (still) a unit of it; true without a cursor. */
  anchored: boolean;
  /** The development's id (S7-06: its edge cache tag), null when not found. */
  developmentId: string | null;
  rows: PublicDocRow[];
}

/**
 * One page of a development's unit table (`/v2/developments/{ref}/units`): its units the site's unit filter matches, in
 * the developer's unit order (reference, then id — neither is shown) after the unit coded `after`, each with its card
 * in the best locale; `limit + 1` rows. The development and the cursor's position are resolved once; the page walks
 * `listing_search_docs_development_ref_idx`. Units without a public code yet are left out. One statement.
 */
export async function developmentUnitsPage(
  tx: Tx,
  q: {
    filter: Filter;
    scope: DevelopmentScope;
    ref: DevelopmentRefMatch;
    after?: string;
    limit: number;
    locale: string;
    fallback: string;
  },
): Promise<DevelopmentUnitsPage> {
  const where = fallbackCondition(q.filter);
  const anchor = q.after
    ? sql`select x.ref, x.target_id from ${listingSearchDocs} x, dev
           where x.public_code = ${q.after} and x.development_id = dev.id`
    : sql`select null::text as ref, null::uuid as target_id where false`;
  const res = await tx.execute(sql`
    with dev as materialized (
      select g.development_id as id, g.ref as own_ref from ${listingSearchDevelopments} g
       where ${refMatchSql(q.scope, q.ref)} and ${scopeSql(q.scope)} and ${memberSql(where)}
       limit 1),
    anchor as materialized (${anchor}),
    u as (
      select s.target_id, s.public_code, s.ref from ${listingSearchDocs} s
       where s.development_id = (select id from dev) and ${where} and s.public_code is not null
         ${q.after ? sql`and (s.ref, s.target_id) > (select a.ref, a.target_id from anchor a)` : sql``}
       order by s.development_id, s.ref, s.target_id limit ${q.limit + 1}),
    page as (
      select m.target_id as "targetId", m.kind, m.agency_id as "ownerAgencyId", u.public_code as "publicCode",
             dc.code as "developmentCode", (select own_ref from dev) as "developmentOwnRef", m.card as doc,
             m.updated_at as "updatedAt", u.ref as sort_ref
        from u join ${listingReadModels} m on m.target_id = u.target_id
         and m.locale = ${bestLocale(sql`u.target_id`, q.locale, q.fallback)}
        left join ${listingPublicCodes} dc on dc.target_id = (select id from dev))
    select exists (select 1 from dev) as found, ${q.after ? sql`exists (select 1 from anchor)` : sql`true`} as anchored,
           (select id from dev) as dev_id, p.*
      from (select 1) one left join page p on true
     order by p.sort_ref, p."targetId"`);
  const raw = res.rows as ({
    found: boolean;
    anchored: boolean;
    dev_id: string | null;
    targetId: string | null;
  } & Record<string, unknown>)[];
  const first = raw[0];
  return {
    found: first?.found === true,
    anchored: first?.anchored === true,
    developmentId: first?.dev_id ?? null,
    rows: docRows(
      raw.filter((r) => r.targetId !== null).map(({ found: _f, anchored: _a, dev_id: _d, sort_ref: _s, ...r }) => r),
    ),
  };
}

/**
 * The developments these references name (engine filters, S7-F6): public codes → their target, own references → the
 * developments of any agency with that reference (a filter beside it keeps the site's own; at most 50 each). One
 * statement for all.
 */
export async function resolveDevelopmentRefs(
  tx: Tx,
  codes: readonly string[],
  ownRefs: readonly string[],
): Promise<{ codes: Map<string, string[]>; ownRefs: Map<string, string[]> }> {
  const out = { codes: new Map<string, string[]>(), ownRefs: new Map<string, string[]>() };
  if (codes.length === 0 && ownRefs.length === 0) return out;
  const texts = (values: readonly string[]) =>
    sql`array[${sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    )}]::text[]`;
  const parts: SQL[] = [];
  if (codes.length > 0) {
    parts.push(sql`select 'code' as k, pc.code as v, pc.target_id as id from ${listingPublicCodes} pc
                    where pc.code = any(${texts(codes)})`);
  }
  if (ownRefs.length > 0) {
    parts.push(sql`select 'ref' as k, r.v, g.development_id as id from unnest(${texts(ownRefs)}) as r(v)
                    cross join lateral (select development_id from ${listingSearchDevelopments}
                                         where lower(ref) = lower(r.v) limit 50) g`);
  }
  const res = await tx.execute(sql.join(parts, sql` union all `));
  for (const r of res.rows as { k: 'code' | 'ref'; v: string; id: string }[]) {
    const map = r.k === 'code' ? out.codes : out.ownRefs;
    const key = r.k === 'code' ? r.v : r.v.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), r.id]);
  }
  return out;
}

/** May the agency's websites show network listings (give-to-get, `website_network_open`)? One statement. */
export async function websiteNetworkOpen(
  tx: Tx,
  agencyId: string,
  minShared: number,
  graceDays: number,
): Promise<boolean> {
  const res = await tx.execute(
    sql`select public.website_network_open(${agencyId}::uuid, ${minShared}::int, ${graceDays}::int) as open`,
  );
  return (res.rows[0] as { open: boolean }).open === true;
}
