/**
 * imports queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/imports` — other modules' tables fail `pnpm check:boundaries`.
 *
 * Request paths run under RLS (`withTenant`): the explicit `agency_id` filters only help the indexes. The worker's
 * run writes run as the agency too (`withTenant`); the scheduler and the prune are cross-agency (`withSystem`).
 */

import { MAPPING_CONNECTORS } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { feedConnections, feedItemErrors, feedMappingProfiles, feedRuns } from '@inmolink/db/schema/imports';
import { and, asc, eq, gt, inArray, or, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

export type ConnectionRow = typeof feedConnections.$inferSelect;
export type ConnectionInsert = typeof feedConnections.$inferInsert;
export type RunRow = typeof feedRuns.$inferSelect;

/** Everything the DTO shows; `hasCredentials` instead of the ciphertext. */
const connectionColumns = {
  id: feedConnections.id,
  agencyId: feedConnections.agencyId,
  name: feedConnections.name,
  connector: feedConnections.connector,
  url: feedConnections.url,
  hasCredentials: sql<boolean>`${feedConnections.credentialsEnc} is not null`,
  settings: feedConnections.settings,
  mappingProfileId: feedConnections.mappingProfileId,
  enabled: feedConnections.enabled,
  scheduleMinutes: feedConnections.scheduleMinutes,
  nextRunAt: feedConnections.nextRunAt,
  lastRunAt: feedConnections.lastRunAt,
  lastRunState: feedConnections.lastRunState,
  version: feedConnections.version,
  createdAt: feedConnections.createdAt,
  updatedAt: feedConnections.updatedAt,
};
const connectionQuery = (tx: Tx) => tx.select(connectionColumns).from(feedConnections);
export type ConnectionView = Awaited<ReturnType<typeof connectionQuery>>[number];

const runColumns = {
  id: feedRuns.id,
  agencyId: feedRuns.agencyId,
  connectionId: feedRuns.connectionId,
  trigger: feedRuns.trigger,
  state: feedRuns.state,
  attempt: feedRuns.attempt,
  itemsTotal: feedRuns.itemsTotal,
  itemsValid: feedRuns.itemsValid,
  itemsFailed: feedRuns.itemsFailed,
  itemsCreated: feedRuns.itemsCreated,
  itemsUpdated: feedRuns.itemsUpdated,
  itemsUnchanged: feedRuns.itemsUnchanged,
  itemsHeld: feedRuns.itemsHeld,
  itemsWithdrawn: feedRuns.itemsWithdrawn,
  errorsLogged: feedRuns.errorsLogged,
  bytesRead: feedRuns.bytesRead,
  errorCode: feedRuns.errorCode,
  startedAt: feedRuns.startedAt,
  finishedAt: feedRuns.finishedAt,
  createdAt: feedRuns.createdAt,
};
const runQuery = (tx: Tx) => tx.select(runColumns).from(feedRuns);
export type RunView = Awaited<ReturnType<typeof runQuery>>[number];

// ── Connections (request paths) ────────────────────────────────────────────────────────────────────────────────

export async function insertConnection(tx: Tx, row: ConnectionInsert): Promise<ConnectionView> {
  const [created] = await tx.insert(feedConnections).values(row).returning(connectionColumns);
  return created as ConnectionView;
}

export async function getConnection(tx: Tx, id: string): Promise<ConnectionView | null> {
  const [row] = await tx.select(connectionColumns).from(feedConnections).where(eq(feedConnections.id, id));
  return row ?? null;
}

export async function getConnectionForUpdate(tx: Tx, id: string): Promise<ConnectionView | null> {
  const [row] = await tx
    .select(connectionColumns)
    .from(feedConnections)
    .where(eq(feedConnections.id, id))
    .for('update');
  return row ?? null;
}

export async function updateConnectionWithVersion(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<ConnectionInsert>,
): Promise<ConnectionView | null> {
  const [row] = await tx
    .update(feedConnections)
    .set({ ...patch, version: sql`${feedConnections.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(feedConnections.id, id), eq(feedConnections.version, version)))
    .returning(connectionColumns);
  return row ?? null;
}

export async function deleteConnection(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.delete(feedConnections).where(eq(feedConnections.id, id)).returning({ id: feedConnections.id });
  return rows.length > 0;
}

export async function listConnections(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<{ items: ConnectionView[]; hasMore: boolean }> {
  const rows = await tx
    .select(connectionColumns)
    .from(feedConnections)
    .where(
      and(
        eq(feedConnections.agencyId, agencyId),
        keysetAfter(feedConnections.createdAt, feedConnections.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrder(feedConnections.createdAt, feedConnections.id, 'desc'))
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

// ── Runs (request paths) ───────────────────────────────────────────────────────────────────────────────────────

/** Queues a run; null when the connection already has a queued or running one (the per-connection mutex). */
export async function insertRun(
  tx: Tx,
  row: {
    id: string;
    agencyId: string;
    connectionId: string;
    trigger: 'SCHEDULE' | 'MANUAL';
    requestedByUserId?: string;
  },
): Promise<RunView | null> {
  const [created] = await tx
    .insert(feedRuns)
    .values(row)
    .onConflictDoNothing({ target: feedRuns.connectionId, where: sql`state in ('QUEUED', 'RUNNING')` })
    .returning(runColumns);
  return created ?? null;
}

export async function listRuns(
  tx: Tx,
  connectionId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<{ items: RunView[]; hasMore: boolean }> {
  const rows = await tx
    .select(runColumns)
    .from(feedRuns)
    .where(and(eq(feedRuns.connectionId, connectionId), keysetAfter(feedRuns.createdAt, feedRuns.id, q.cursor, 'desc')))
    .orderBy(...keysetOrder(feedRuns.createdAt, feedRuns.id, 'desc'))
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

export async function getRun(tx: Tx, runId: string): Promise<RunView | null> {
  const [row] = await tx.select(runColumns).from(feedRuns).where(eq(feedRuns.id, runId));
  return row ?? null;
}

/** A run's errors in feed order; the cursor is the last (position, id). */
export async function listItemErrors(
  tx: Tx,
  runId: string,
  q: { limit: number; after?: { position: number; id: string } },
) {
  const after = q.after;
  const rows = await tx
    .select({
      id: feedItemErrors.id,
      position: feedItemErrors.position,
      itemRef: feedItemErrors.itemRef,
      code: feedItemErrors.code,
      field: feedItemErrors.field,
      message: feedItemErrors.message,
    })
    .from(feedItemErrors)
    .where(
      and(
        eq(feedItemErrors.runId, runId),
        after
          ? or(
              gt(feedItemErrors.position, after.position),
              and(eq(feedItemErrors.position, after.position), gt(feedItemErrors.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(feedItemErrors.position), asc(feedItemErrors.id))
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

// ── Run lifecycle (worker, as the agency) ──────────────────────────────────────────────────────────────────────

/** One bind parameter for a whole id list (ids come from the database or `newId`, never from a request). */
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

const leaseUntil = (leaseMs: number) => sql`now() + ${`${leaseMs} milliseconds`}::interval`;

/**
 * Claims a run for this worker: QUEUED, or RUNNING with a lapsed lease (its worker died). A new fencing token
 * and lease; the counters start over (the loader is idempotent, S6-02). Null when the run is not claimable —
 * another worker holds it, or it ended.
 */
export async function claimRun(
  tx: Tx,
  runId: string,
  token: string,
  leaseMs: number,
): Promise<{ connectionId: string; attempt: number } | null> {
  const [row] = await tx
    .update(feedRuns)
    .set({
      state: 'RUNNING',
      leaseToken: token,
      leaseUntil: leaseUntil(leaseMs),
      attempt: sql`${feedRuns.attempt} + 1`,
      startedAt: sql`coalesce(${feedRuns.startedAt}, now())`,
      itemsTotal: 0,
      itemsValid: 0,
      itemsFailed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 0,
      itemsHeld: 0,
      itemsWithdrawn: 0,
      errorsLogged: 0,
      bytesRead: 0,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(feedRuns.id, runId),
        or(
          eq(feedRuns.state, 'QUEUED'),
          and(eq(feedRuns.state, 'RUNNING'), sql`${feedRuns.leaseUntil} < now()`),
        ) as SQL,
      ),
    )
    .returning({ connectionId: feedRuns.connectionId, attempt: feedRuns.attempt });
  if (!row) return null;
  if (row.attempt > 1) await tx.delete(feedItemErrors).where(eq(feedItemErrors.runId, runId));
  return row;
}

/** The connection a claimed run fetches, credentials (ciphertext) and mapping included. */
export async function connectionForRun(tx: Tx, connectionId: string) {
  const [row] = await tx
    .select({
      id: feedConnections.id,
      agencyId: feedConnections.agencyId,
      connector: feedConnections.connector,
      url: feedConnections.url,
      credentialsEnc: feedConnections.credentialsEnc,
      settings: feedConnections.settings,
      enabled: feedConnections.enabled,
      mapping: feedMappingProfiles.mapping,
    })
    .from(feedConnections)
    .leftJoin(feedMappingProfiles, eq(feedMappingProfiles.id, feedConnections.mappingProfileId))
    .where(eq(feedConnections.id, connectionId));
  return row ?? null;
}

/**
 * Adds a batch's counts to the run and renews the lease, while `token` holds it (the caller locked the row with
 * `lockRunForBatch` in the same transaction).
 */
export async function addBatchCounts(
  tx: Tx,
  runId: string,
  token: string,
  leaseMs: number,
  d: {
    total: number;
    valid: number;
    failed: number;
    created: number;
    updated: number;
    unchanged: number;
    held: number;
    logged: number;
    bytesRead: number;
  },
): Promise<boolean> {
  const rows = await tx
    .update(feedRuns)
    .set({
      itemsTotal: sql`${feedRuns.itemsTotal} + ${d.total}`,
      itemsValid: sql`${feedRuns.itemsValid} + ${d.valid}`,
      itemsFailed: sql`${feedRuns.itemsFailed} + ${d.failed}`,
      itemsCreated: sql`${feedRuns.itemsCreated} + ${d.created}`,
      itemsUpdated: sql`${feedRuns.itemsUpdated} + ${d.updated}`,
      itemsUnchanged: sql`${feedRuns.itemsUnchanged} + ${d.unchanged}`,
      itemsHeld: sql`${feedRuns.itemsHeld} + ${d.held}`,
      errorsLogged: sql`${feedRuns.errorsLogged} + ${d.logged}`,
      bytesRead: d.bytesRead,
      leaseUntil: leaseUntil(leaseMs),
      updatedAt: sql`now()`,
    })
    .where(and(eq(feedRuns.id, runId), eq(feedRuns.state, 'RUNNING'), eq(feedRuns.leaseToken, token)))
    .returning({ id: feedRuns.id });
  return rows.length > 0;
}

/** Errors logged so far, while `token` holds the run (null: lease lost). Locks the row for the batch. */
export async function lockRunForBatch(tx: Tx, runId: string, token: string): Promise<number | null> {
  const [row] = await tx
    .select({ logged: feedRuns.errorsLogged })
    .from(feedRuns)
    .where(and(eq(feedRuns.id, runId), eq(feedRuns.state, 'RUNNING'), eq(feedRuns.leaseToken, token)))
    .for('update');
  return row ? row.logged : null;
}

export async function insertItemErrors(tx: Tx, rows: (typeof feedItemErrors.$inferInsert)[]): Promise<void> {
  if (rows.length) await tx.insert(feedItemErrors).values(rows);
}

export async function renewLease(tx: Tx, runId: string, token: string, leaseMs: number): Promise<boolean> {
  const rows = await tx
    .update(feedRuns)
    .set({ leaseUntil: leaseUntil(leaseMs) })
    .where(and(eq(feedRuns.id, runId), eq(feedRuns.state, 'RUNNING'), eq(feedRuns.leaseToken, token)))
    .returning({ id: feedRuns.id });
  return rows.length > 0;
}

/** Ends the run if `token` still holds it; records the outcome on the connection. Null when the lease was lost. */
export async function finishRun(
  tx: Tx,
  runId: string,
  token: string,
  outcome: { state: 'SUCCEEDED' | 'FAILED'; errorCode: string | null },
): Promise<{ connectionId: string; agencyId: string; itemsValid: number } | null> {
  const [row] = await tx
    .update(feedRuns)
    .set({
      state: outcome.state,
      errorCode: outcome.errorCode,
      leaseToken: null,
      leaseUntil: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(feedRuns.id, runId), eq(feedRuns.state, 'RUNNING'), eq(feedRuns.leaseToken, token)))
    .returning({ connectionId: feedRuns.connectionId, agencyId: feedRuns.agencyId, itemsValid: feedRuns.itemsValid });
  if (!row) return null;
  await tx
    .update(feedConnections)
    .set({ lastRunAt: sql`now()`, lastRunState: outcome.state })
    .where(eq(feedConnections.id, row.connectionId));
  return row;
}

/** Records the listings the end of a run withdrew (the caller ended the run in this transaction). */
export async function setWithdrawn(tx: Tx, runId: string, withdrawn: number): Promise<void> {
  await tx.update(feedRuns).set({ itemsWithdrawn: withdrawn }).where(eq(feedRuns.id, runId));
}

/** A run's state and how long its current lease still runs (ms, ≤ 0 when lapsed), or null. */
export async function runLease(tx: Tx, runId: string): Promise<{ state: string; leaseLeftMs: number | null } | null> {
  const r = await tx.execute<{ state: string; left_ms: number | null }>(sql`
    select state, (extract(epoch from (lease_until - now())) * 1000)::int as left_ms
    from feed_runs where id = ${runId}`);
  const row = r.rows[0];
  return row ? { state: row.state, leaseLeftMs: row.left_ms === null ? null : Number(row.left_ms) } : null;
}

/** Hands the run back to the queue for the job's next attempt (a retryable error), if `token` still holds it. */
export async function releaseRun(tx: Tx, runId: string, token: string): Promise<boolean> {
  const rows = await tx
    .update(feedRuns)
    .set({ state: 'QUEUED', leaseToken: null, leaseUntil: null, updatedAt: sql`now()` })
    .where(and(eq(feedRuns.id, runId), eq(feedRuns.state, 'RUNNING'), eq(feedRuns.leaseToken, token)))
    .returning({ id: feedRuns.id });
  return rows.length > 0;
}

// ── Scheduler and retention (worker, all agencies via withSystem) ──────────────────────────────────────────────

/**
 * Fails the runs whose worker is gone: RUNNING with a lease lapsed more than `leaseGraceMs` ago
 * (`FEED_LEASE_EXPIRED`), QUEUED for more than `queuedStaleMs` (`FEED_NEVER_STARTED`). Frees their slots.
 */
export async function failStaleRuns(
  tx: Tx,
  leaseGraceMs: number,
  queuedStaleMs: number,
): Promise<{ id: string; agencyId: string; connectionId: string; errorCode: string }[]> {
  const r = await tx.execute<{ id: string; agency_id: string; connection_id: string; error_code: string }>(sql`
    with stale as (
      select id, case when state = 'RUNNING' then 'FEED_LEASE_EXPIRED' else 'FEED_NEVER_STARTED' end as code
      from feed_runs
      where (state = 'RUNNING' and lease_until < now() - ${`${leaseGraceMs} milliseconds`}::interval)
         or (state = 'QUEUED' and created_at < now() - ${`${queuedStaleMs} milliseconds`}::interval)
      for update skip locked
    ), failed as (
      update feed_runs r set state = 'FAILED', error_code = s.code, lease_token = null, lease_until = null,
        finished_at = now(), updated_at = now()
      from stale s where r.id = s.id
      returning r.id, r.agency_id, r.connection_id, r.error_code
    ), touched as (
      update feed_connections c set last_run_at = now(), last_run_state = 'FAILED'
      from failed f where c.id = f.connection_id
    )
    select id, agency_id, connection_id, error_code from failed`);
  return r.rows.map((x) => ({
    id: x.id,
    agencyId: x.agency_id,
    connectionId: x.connection_id,
    errorCode: x.error_code,
  }));
}

/**
 * Starts the due connections' scheduled runs: claims up to `limit` enabled connections (≤ `perAgency` each) whose `next_run_at` passed
 * (`SKIP LOCKED`: concurrent ticks split the work), queues one run each unless one is already active (the mutex
 * makes that a no-op), and moves `next_run_at` one interval on. Returns the runs queued.
 */
export async function queueDueRuns(
  tx: Tx,
  limit: number,
  perAgency: number,
  newIds: () => string,
): Promise<{ id: string; agencyId: string; connectionId: string }[]> {
  // Fair share: at most `perAgency` connections of one agency per tick (the next tick takes the rest), then
  // lock the chosen rows (`SKIP LOCKED`: concurrent ticks split the work; a window query cannot lock).
  const due = await tx.execute<{ id: string; agency_id: string }>(sql`
    select id, agency_id from feed_connections
    where id = any(array(
      select id from (
        select id, next_run_at, row_number() over (partition by agency_id order by next_run_at) as n
        from feed_connections
        where enabled and next_run_at is not null and next_run_at <= now()
      ) ranked
      where n <= ${perAgency}
      order by next_run_at
      limit ${limit}))
    and enabled and next_run_at <= now()
    for update skip locked`);
  if (due.rows.length === 0) return [];
  const ids = due.rows.map((r) => r.id);
  await tx.execute(sql`
    update feed_connections
    set next_run_at = now() + make_interval(mins => schedule_minutes)
    where id = any(${uuidArray(ids)}) and schedule_minutes is not null`);
  const runIds = due.rows.map(() => newIds());
  const r = await tx.execute<{ id: string; agency_id: string; connection_id: string }>(sql`
    insert into feed_runs (id, agency_id, connection_id, trigger)
    select * from unnest(${uuidArray(runIds)}, ${uuidArray(due.rows.map((x) => x.agency_id))}, ${uuidArray(ids)},
      array_fill('SCHEDULE'::feed_run_trigger, array[${ids.length}::int]))
    on conflict (connection_id) where state in ('QUEUED', 'RUNNING') do nothing
    returning id, agency_id, connection_id`);
  return r.rows.map((x) => ({ id: x.id, agencyId: x.agency_id, connectionId: x.connection_id }));
}

/** Deletes up to `limit` finished runs created before `before` (their errors cascade). */
export async function pruneRuns(tx: Tx, before: Date, limit: number): Promise<number> {
  const r = await tx.execute(sql`
    delete from feed_runs where id in (
      select id from feed_runs
      where state in ('SUCCEEDED', 'FAILED') and created_at < ${before}
      order by created_at
      limit ${limit})`);
  return r.rowCount ?? 0;
}

// ── Mapping profiles (request paths, S6-04) ────────────────────────────────────────────────────────────────────

const profileColumns = {
  id: feedMappingProfiles.id,
  agencyId: feedMappingProfiles.agencyId,
  name: feedMappingProfiles.name,
  connector: feedMappingProfiles.connector,
  mapping: feedMappingProfiles.mapping,
  version: feedMappingProfiles.version,
  createdAt: feedMappingProfiles.createdAt,
  updatedAt: feedMappingProfiles.updatedAt,
};
const { mapping: _mapping, ...summaryColumns } = profileColumns;
export type ProfileSummary = Omit<ProfileView, 'mapping'>;
const profileQuery = (tx: Tx) => tx.select(profileColumns).from(feedMappingProfiles);
export type ProfileView = Awaited<ReturnType<typeof profileQuery>>[number];
export type ProfileInsert = typeof feedMappingProfiles.$inferInsert;

export async function insertProfile(tx: Tx, row: ProfileInsert): Promise<ProfileView> {
  const [created] = await tx.insert(feedMappingProfiles).values(row).returning(profileColumns);
  return created as ProfileView;
}

export async function getProfile(tx: Tx, id: string): Promise<ProfileView | null> {
  const [row] = await tx
    .select(profileColumns)
    .from(feedMappingProfiles)
    .where(and(eq(feedMappingProfiles.id, id), inArray(feedMappingProfiles.connector, [...MAPPING_CONNECTORS])));
  return row ?? null;
}

export async function getProfileForUpdate(tx: Tx, id: string): Promise<ProfileView | null> {
  const [row] = await tx
    .select(profileColumns)
    .from(feedMappingProfiles)
    .where(and(eq(feedMappingProfiles.id, id), inArray(feedMappingProfiles.connector, [...MAPPING_CONNECTORS])))
    .for('update');
  return row ?? null;
}

export async function updateProfileWithVersion(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<Pick<ProfileInsert, 'name' | 'mapping'>>,
): Promise<ProfileView | null> {
  const [row] = await tx
    .update(feedMappingProfiles)
    .set({ ...patch, version: sql`${feedMappingProfiles.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(
        eq(feedMappingProfiles.id, id),
        eq(feedMappingProfiles.version, version),
        inArray(feedMappingProfiles.connector, [...MAPPING_CONNECTORS]),
      ),
    )
    .returning(profileColumns);
  return row ?? null;
}

export async function listProfiles(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor; connector: string },
): Promise<{ items: ProfileSummary[]; hasMore: boolean }> {
  const rows = await tx
    .select(summaryColumns)
    .from(feedMappingProfiles)
    .where(
      and(
        eq(feedMappingProfiles.agencyId, agencyId),
        eq(feedMappingProfiles.connector, q.connector),
        keysetAfter(feedMappingProfiles.createdAt, feedMappingProfiles.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrder(feedMappingProfiles.createdAt, feedMappingProfiles.id, 'desc'))
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

/** The connector key of a profile, or null when it does not exist (for this agency). */
export async function profileConnector(tx: Tx, id: string): Promise<string | null> {
  const [row] = await tx
    .select({ connector: feedMappingProfiles.connector })
    .from(feedMappingProfiles)
    .where(eq(feedMappingProfiles.id, id));
  return row?.connector ?? null;
}
