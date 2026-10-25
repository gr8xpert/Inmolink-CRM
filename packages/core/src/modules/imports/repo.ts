/**
 * imports queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/imports` — other modules' tables fail `pnpm check:boundaries`.
 *
 * Request paths run under RLS (`withTenant`): the explicit `agency_id` filters only help the indexes. The worker's
 * run writes run as the agency too (`withTenant`); the scheduler and the prune are cross-agency (`withSystem`).
 */

import { MAPPING_CONNECTORS } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import {
  feedConnections,
  feedItemErrors,
  feedMappingProfiles,
  feedRuns,
  feedSheetReleases,
  feedSourceHashes,
} from '@inmolink/db/schema/imports';
import { and, asc, desc, eq, gt, inArray, or, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

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
  pausedAt: feedConnections.pausedAt,
  pauseReason: feedConnections.pauseReason,
  pauseDetails: feedConnections.pauseDetails,
  pausedRunId: feedConnections.pausedRunId,
  acceptAnomalyOnce: feedConnections.acceptAnomalyOnce,
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
  errorDetail: feedRuns.errorDetail,
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
): Promise<{ items: (ConnectionView & { atUs: string })[]; hasMore: boolean }> {
  const rows = await tx
    .select({ ...connectionColumns, atUs: keysetStamp(feedConnections.createdAt) })
    .from(feedConnections)
    .where(
      and(
        eq(feedConnections.agencyId, agencyId),
        keysetAfterRaw(feedConnections.createdAt, feedConnections.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(feedConnections.createdAt, feedConnections.id, 'desc'))
    .limit(q.limit + 1);
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

// ── Uploaded sheets (S7-F1) ────────────────────────────────────────────────────────────────────────────────────

/** Whether a connection of the agency (RLS) still points at this sheet url (`feed_connections_sheet_url_idx`). */
export async function sheetInUse(tx: Tx, url: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: feedConnections.id })
    .from(feedConnections)
    .where(and(eq(feedConnections.connector, 'sheet-mapped'), eq(feedConnections.url, url)))
    .limit(1);
  return row !== undefined;
}

/**
 * The sweep (all agencies, `withSystem`): for each sheet url of the page, when its connections were last active —
 * the latest of their last run, creation and change, or now while one of them has a queued or running run. A url
 * missing from the answer has no connection. One statement per page (`feed_connections_sheet_url_idx`, the active
 * runs through `feed_runs_active_idx`).
 */
export async function sheetActivity(
  tx: Tx,
  keys: readonly { agencyId: string; url: string }[],
): Promise<Map<string, Date>> {
  if (keys.length === 0) return new Map();
  // one array parameter: sheet urls are `upload://<uuid>` (no comma, quote or brace to escape)
  if (keys.some((k) => !/^upload:\/\/[0-9a-f-]{36}$/.test(k.url))) throw new Error('sheetActivity: not a sheet url');
  const r = await tx.execute<{ agency_id: string; url: string; active_at: Date | string }>(sql`
    select c.agency_id, c.url,
           max(case when exists (select 1 from feed_runs r
                                  where r.connection_id = c.id and r.state in ('QUEUED', 'RUNNING'))
                    then now()
                    else greatest(coalesce(c.last_run_at, c.created_at), c.updated_at) end) as active_at
      from feed_connections c
     where c.connector = 'sheet-mapped'
       and c.url = any(${`{${keys.map((k) => k.url).join(',')}}`}::text[])
     group by c.agency_id, c.url`);
  const wanted = new Set(keys.map((k) => `${k.agencyId}|${k.url}`));
  const out = new Map<string, Date>();
  for (const row of r.rows) {
    const key = `${row.agency_id}|${row.url}`;
    if (wanted.has(key)) out.set(key, new Date(row.active_at));
  }
  return out;
}

/**
 * The uploaded files' advisory locks (transaction-scoped), in a fixed order so two lockers never deadlock. Taken by
 * `startSheetImport` before it points a connection at a file and by the release job / sweep before they mark a file
 * released: a file is never released while a connection starts using it, and never used once released.
 */
export async function lockSheets(tx: Tx, fileIds: readonly string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const keys = [...new Set(fileIds.map((f) => `imports.sheet:${f.toLowerCase()}`))].sort();
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(k, 0))
      from unnest(${`{${keys.join(',')}}`}::text[]) as k order by k`);
}

/** Whether the agency's file was released (RLS; the primary key). */
export async function sheetReleased(tx: Tx, agencyId: string, fileId: string): Promise<boolean> {
  const [row] = await tx
    .select({ fileId: feedSheetReleases.fileId })
    .from(feedSheetReleases)
    .where(and(eq(feedSheetReleases.agencyId, agencyId), eq(feedSheetReleases.fileId, fileId)));
  return row !== undefined;
}

/** Marks files released (idempotent); the caller holds their locks and deletes the objects after the commit. */
export async function insertSheetReleases(
  tx: Tx,
  rows: readonly { agencyId: string; fileId: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(feedSheetReleases)
    .values([...rows])
    .onConflictDoNothing();
}

/** Release tombstones older than `before`, `limit` per statement (`feed_sheet_releases_released_at_idx`). */
export async function pruneSheetReleases(tx: Tx, before: Date, limit: number): Promise<number> {
  const r = await tx.execute(sql`
    delete from feed_sheet_releases where (agency_id, file_id) in (
      select agency_id, file_id from feed_sheet_releases
       where released_at < ${before.toISOString()}::timestamptz order by released_at limit ${limit})`);
  return r.rowCount ?? 0;
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
): Promise<{ items: (RunView & { atUs: string })[]; hasMore: boolean }> {
  const rows = await tx
    .select({ ...runColumns, atUs: keysetStamp(feedRuns.createdAt) })
    .from(feedRuns)
    .where(
      and(eq(feedRuns.connectionId, connectionId), keysetAfterRaw(feedRuns.createdAt, feedRuns.id, q.cursor, 'desc')),
    )
    .orderBy(...keysetOrderRaw(feedRuns.createdAt, feedRuns.id, 'desc'))
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

/** A claimed run: what the claim left on the row (S7-F12: counters and checkpoint survive the claim). */
export interface RunClaim {
  connectionId: string;
  attempt: number;
  startedAt: Date;
  /** Where the run resumes (`{ fp, at }`), or null: it starts at the beginning. */
  checkpoint: unknown;
  itemsTotal: number;
  itemsValid: number;
}

/**
 * Claims a run for this worker: QUEUED, or RUNNING with a lapsed lease (its worker died). A new fencing token
 * and lease. S7-F12: counters, item errors and the checkpoint stay — in the same transaction the caller either resumes
 * from the checkpoint or starts the run over (`restartRun`; the loader is idempotent, S6-02). Null when the run is not
 * claimable — another worker holds it, or it ended.
 */
export async function claimRun(tx: Tx, runId: string, token: string, leaseMs: number): Promise<RunClaim | null> {
  const [row] = await tx
    .update(feedRuns)
    .set({
      state: 'RUNNING',
      leaseToken: token,
      leaseUntil: leaseUntil(leaseMs),
      attempt: sql`${feedRuns.attempt} + 1`,
      startedAt: sql`coalesce(${feedRuns.startedAt}, now())`,
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
    .returning({
      connectionId: feedRuns.connectionId,
      attempt: feedRuns.attempt,
      startedAt: feedRuns.startedAt,
      checkpoint: feedRuns.checkpoint,
      itemsTotal: feedRuns.itemsTotal,
      itemsValid: feedRuns.itemsValid,
    });
  if (!row) return null;
  return { ...row, startedAt: row.startedAt as Date };
}

/**
 * Starts a claimed run over (in the claiming transaction, fenced by it): counters, checkpoint and the earlier attempts'
 * item errors go. The caller drops the sink's seen references in the same transaction.
 */
export async function restartRun(tx: Tx, runId: string): Promise<void> {
  await tx
    .update(feedRuns)
    .set({
      itemsTotal: 0,
      itemsValid: 0,
      itemsFailed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 0,
      itemsHeld: 0,
      itemsWithdrawn: 0,
      itemsSeen: 0,
      errorsLogged: 0,
      bytesRead: 0,
      checkpoint: null,
    })
    .where(eq(feedRuns.id, runId));
  await tx.delete(feedItemErrors).where(eq(feedItemErrors.runId, runId));
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
      pausedAt: feedConnections.pausedAt,
      acceptAnomalyOnce: feedConnections.acceptAnomalyOnce,
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
    /** S7-F3: seen references the batch recorded. */
    seen: number;
    logged: number;
    bytesRead: number;
    /** S7-F12: the batch ended on a page boundary: the run resumes after it (`{ fp, at }`). */
    checkpoint?: unknown;
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
      itemsSeen: sql`${feedRuns.itemsSeen} + ${d.seen}`,
      errorsLogged: sql`${feedRuns.errorsLogged} + ${d.logged}`,
      bytesRead: d.bytesRead,
      ...(d.checkpoint === undefined ? {} : { checkpoint: d.checkpoint }),
      leaseUntil: leaseUntil(leaseMs),
      updatedAt: sql`now()`,
    })
    .where(and(eq(feedRuns.id, runId), eq(feedRuns.state, 'RUNNING'), eq(feedRuns.leaseToken, token)))
    .returning({ id: feedRuns.id });
  return rows.length > 0;
}

/** S7-F3: seen references the run's current attempt recorded (its logged count). */
export async function runSeenCount(tx: Tx, runId: string): Promise<number> {
  const [row] = await tx.select({ seen: feedRuns.itemsSeen }).from(feedRuns).where(eq(feedRuns.id, runId));
  return row?.seen ?? 0;
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
  outcome: { state: 'SUCCEEDED' | 'FAILED'; errorCode: string | null; errorDetail?: string | null },
): Promise<{
  connectionId: string;
  agencyId: string;
  itemsValid: number;
  itemsCreated: number;
  itemsUpdated: number;
} | null> {
  const [row] = await tx
    .update(feedRuns)
    .set({
      state: outcome.state,
      errorCode: outcome.errorCode,
      errorDetail: outcome.errorDetail ?? null,
      checkpoint: null,
      leaseToken: null,
      leaseUntil: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(feedRuns.id, runId), eq(feedRuns.state, 'RUNNING'), eq(feedRuns.leaseToken, token)))
    .returning({
      connectionId: feedRuns.connectionId,
      agencyId: feedRuns.agencyId,
      itemsValid: feedRuns.itemsValid,
      itemsCreated: feedRuns.itemsCreated,
      itemsUpdated: feedRuns.itemsUpdated,
    });
  if (!row) return null;
  await tx
    .update(feedConnections)
    .set({ lastRunAt: sql`now()`, lastRunState: outcome.state })
    .where(eq(feedConnections.id, row.connectionId));
  return row;
}

/**
 * Item counts of the connection's last `n` successful runs, newest first (the anomaly guard's baseline, S6-08).
 * `feed_runs_connection_created_idx` (its leading column; the order by is the index's expression, so it reads
 * backwards); a connection keeps ≤ 90 days of runs.
 */
export async function recentSucceededTotals(tx: Tx, connectionId: string, n: number): Promise<number[]> {
  const rows = await tx
    .select({ total: feedRuns.itemsTotal })
    .from(feedRuns)
    .where(and(eq(feedRuns.connectionId, connectionId), eq(feedRuns.state, 'SUCCEEDED')))
    .orderBy(desc(sql`date_trunc('milliseconds', ${feedRuns.createdAt}, 'UTC')`), desc(feedRuns.id))
    .limit(n);
  return rows.map((r) => r.total);
}

/**
 * The anomaly guard paused the connection (S6-08); "accept the change" from an earlier resume is used up, and the
 * connection leaves the scheduler's due index (`next_run_at` null; a resume plans it again).
 */
export async function pauseConnection(
  tx: Tx,
  connectionId: string,
  pause: { reason: string; details: Record<string, unknown>; runId: string },
): Promise<void> {
  await tx
    .update(feedConnections)
    .set({
      pausedAt: sql`now()`,
      pauseReason: pause.reason,
      pauseDetails: pause.details,
      pausedRunId: pause.runId,
      acceptAnomalyOnce: false,
      // S7-F1: a staff reason belongs to the pause it lifted; a new pause starts without one
      staffResumeReason: null,
      nextRunAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(feedConnections.id, connectionId));
}

/**
 * After a successful run (S6-08): "accept the change" is used up, and a run that added, changed or removed an item
 * moves `content_changed_at`. Answers the connection's last content change (null: none known).
 */
export async function recordRunSuccess(tx: Tx, connectionId: string, changed: boolean): Promise<Date | null> {
  const [row] = await tx
    .update(feedConnections)
    .set({
      acceptAnomalyOnce: false,
      ...(changed ? { contentChangedAt: sql`now()` } : {}),
    })
    .where(eq(feedConnections.id, connectionId))
    .returning({ contentChangedAt: feedConnections.contentChangedAt });
  return row?.contentChangedAt ?? null;
}

/**
 * Resumes a paused connection (agency admin or staff, S6-08): the pause is cleared, `acceptChange` lets the next run
 * skip the guard once, and a scheduled connection is due at once. Null when it does not exist.
 */
export async function resumeConnection(
  tx: Tx,
  connectionId: string,
  acceptChange: boolean,
): Promise<ConnectionView | null> {
  const [row] = await tx
    .update(feedConnections)
    .set({
      pausedAt: null,
      pauseReason: null,
      pauseDetails: null,
      pausedRunId: null,
      acceptAnomalyOnce: acceptChange,
      // S7-F1: resumed by the agency, not staff — no staff reason applies to this resume
      staffResumeReason: null,
      nextRunAt: sql`case when ${feedConnections.enabled} and ${feedConnections.scheduleMinutes} is not null
        then now() else ${feedConnections.nextRunAt} end`,
      version: sql`${feedConnections.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(feedConnections.id, connectionId))
    .returning(connectionColumns);
  return row ?? null;
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

/**
 * Hands the run back to the queue, if `token` still holds it: for the job's next attempt (a retryable error) or, S7-F12,
 * for the run's next slice (a new job). The checkpoint stays unless `restart` (the next claim then starts over).
 * Answers the claim number that ends here (the next slice's job id), or null when the lease was lost.
 */
export async function releaseRun(
  tx: Tx,
  runId: string,
  token: string,
  opts: { restart?: boolean } = {},
): Promise<number | null> {
  const [row] = await tx
    .update(feedRuns)
    .set({
      state: 'QUEUED',
      leaseToken: null,
      leaseUntil: null,
      ...(opts.restart ? { checkpoint: null } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(feedRuns.id, runId), eq(feedRuns.state, 'RUNNING'), eq(feedRuns.leaseToken, token)))
    .returning({ attempt: feedRuns.attempt });
  return row ? row.attempt : null;
}

/**
 * S7-F12: the runs still queued or running, of every agency (the seen-reference prune keeps theirs). At most one per
 * connection; `feed_runs_active_idx`.
 */
export async function activeRunIds(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: feedRuns.id })
    .from(feedRuns)
    .where(inArray(feedRuns.state, ['QUEUED', 'RUNNING']));
  return rows.map((r) => r.id);
}

// ── Scheduler and retention (worker, all agencies via withSystem) ──────────────────────────────────────────────

/**
 * Fails the runs whose worker is gone: RUNNING with a lease lapsed more than `leaseGraceMs` ago
 * (`FEED_LEASE_EXPIRED`), QUEUED for more than `queuedStaleMs` (`FEED_NEVER_STARTED`). Frees their slots. S7-F12: a
 * queued run's wait counts from when it was last queued (`updated_at`: created, or handed back for a retry or its next
 * slice), so a long run between slices is not taken for a lost one. The active runs are few (≤ one per connection):
 * `feed_runs_active_idx` reads the QUEUED ones and filters.
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
         or (state = 'QUEUED' and updated_at < now() - ${`${queuedStaleMs} milliseconds`}::interval)
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
 * makes that a no-op), and moves `next_run_at` one interval on. Returns the runs queued and how many connections it
 * claimed (S7-F3: the scheduler runs another batch while a batch claims `limit`).
 */
export async function queueDueRuns(
  tx: Tx,
  limit: number,
  perAgency: number,
  newIds: () => string,
): Promise<{ claimed: number; runs: { id: string; agencyId: string; connectionId: string }[] }> {
  // Fair share: at most `perAgency` connections of one agency per tick (the next tick takes the rest), then
  // lock the chosen rows (`SKIP LOCKED`: concurrent ticks split the work; a window query cannot lock).
  const due = await tx.execute<{ id: string; agency_id: string }>(sql`
    select id, agency_id from feed_connections
    where id = any(array(
      select id from (
        select id, next_run_at, row_number() over (partition by agency_id order by next_run_at) as n
        from feed_connections
        where enabled and next_run_at is not null and next_run_at <= now() and paused_at is null
      ) ranked
      where n <= ${perAgency}
      order by next_run_at
      limit ${limit}))
    and enabled and next_run_at <= now() and paused_at is null
    for update skip locked`);
  if (due.rows.length === 0) return { claimed: 0, runs: [] };
  const ids = due.rows.map((r) => r.id);
  await tx.execute(sql`
    update feed_connections
    set next_run_at = case when schedule_minutes is null then null else now() + make_interval(mins => schedule_minutes) end
    where id = any(${uuidArray(ids)})`);
  const runIds = due.rows.map(() => newIds());
  const r = await tx.execute<{ id: string; agency_id: string; connection_id: string }>(sql`
    insert into feed_runs (id, agency_id, connection_id, trigger)
    select * from unnest(${uuidArray(runIds)}, ${uuidArray(due.rows.map((x) => x.agency_id))}, ${uuidArray(ids)},
      array_fill('SCHEDULE'::feed_run_trigger, array[${ids.length}::int]))
    on conflict (connection_id) where state in ('QUEUED', 'RUNNING') do nothing
    returning id, agency_id, connection_id`);
  return {
    claimed: due.rows.length,
    runs: r.rows.map((x) => ({ id: x.id, agencyId: x.agency_id, connectionId: x.connection_id })),
  };
}

/**
 * Deletes finished runs created before `before`, oldest first: at most `limit` runs, and only as many as keep their
 * item errors (which cascade) within `maxErrors` — always at least one (S7-F3: 2,000 runs × 1,000 errors would be 2M
 * rows in one transaction). Answers the runs and errors deleted.
 */
export async function pruneRuns(
  tx: Tx,
  before: Date,
  limit: number,
  maxErrors: number,
): Promise<{ runs: number; errors: number }> {
  const r = await tx.execute<{ runs: number; errors: number }>(sql`
    with doomed as (
      select id from (
        select id, row_number() over w as n, sum(errors_logged) over w as errors
          from (select id, created_at, errors_logged from feed_runs
                 where state in ('SUCCEEDED', 'FAILED') and created_at < ${before}
                 order by created_at limit ${limit}) oldest
        window w as (order by created_at, id)
      ) ranked
      where n = 1 or errors <= ${maxErrors}
    ), gone as (
      delete from feed_runs r using doomed d where r.id = d.id returning r.errors_logged
    )
    select count(*)::int as runs, coalesce(sum(errors_logged), 0)::int as errors from gone`);
  const row = r.rows[0];
  return { runs: Number(row?.runs ?? 0), errors: Number(row?.errors ?? 0) };
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
): Promise<{ items: (ProfileSummary & { atUs: string })[]; hasMore: boolean }> {
  const rows = await tx
    .select({ ...summaryColumns, atUs: keysetStamp(feedMappingProfiles.createdAt) })
    .from(feedMappingProfiles)
    .where(
      and(
        eq(feedMappingProfiles.agencyId, agencyId),
        eq(feedMappingProfiles.connector, q.connector),
        keysetAfterRaw(feedMappingProfiles.createdAt, feedMappingProfiles.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(feedMappingProfiles.createdAt, feedMappingProfiles.id, 'desc'))
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

// ── Import health (staff, every agency: `app_staff` reads all rows; scheduler metrics via withSystem) ──────────

/**
 * Queued and running runs now, and how long the oldest run waiting for its first start has waited
 * (`feed_runs_active_idx`). A run handed back for a retry keeps its `created_at` and waits out its backoff: not lag.
 */
export async function queueSnapshot(tx: Tx): Promise<{ queued: number; running: number; oldestQueuedSeconds: number }> {
  const r = await tx.execute<{ queued: number; running: number; oldest: number | null }>(sql`
    select count(*) filter (where state = 'QUEUED')::int as queued,
           count(*) filter (where state = 'RUNNING')::int as running,
           extract(epoch from (now() - min(created_at) filter (where state = 'QUEUED' and started_at is null)))::int
             as oldest
      from feed_runs where state in ('QUEUED', 'RUNNING')`);
  const row = r.rows[0];
  return {
    queued: Number(row?.queued ?? 0),
    running: Number(row?.running ?? 0),
    oldestQueuedSeconds: Number(row?.oldest ?? 0),
  };
}

/** `percentile_cont(q)` of a histogram of whole values (value → count): linear between the two nearest ranks. */
export function histogramPercentile(histogram: readonly { value: number; count: number }[], q: number): number {
  const sorted = [...histogram].filter((h) => h.count > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((n, h) => n + h.count, 0);
  if (total === 0) return 0;
  const rank = (total - 1) * q;
  const valueAt = (i: number) => {
    let seen = 0;
    for (const h of sorted) {
      seen += h.count;
      if (i < seen) return h.value;
    }
    return (sorted[sorted.length - 1] as { value: number }).value;
  };
  const lo = valueAt(Math.floor(rank));
  const hi = valueAt(Math.ceil(rank));
  return lo + (hi - lo) * (rank - Math.floor(rank));
}

/**
 * The queue-wait histogram's buckets (S7-F10 perf review), in whole seconds: by the second up to 10 min, by 10 s up to
 * 1 h, by the minute up to a day, by the hour up to a week, then one bucket — a bucket's value is its lower bound. At most
 * `WAIT_HISTOGRAM_MAX_ROWS` rows whatever the backlog (by the second, a lagging queue returned one row per distinct
 * wait). `waitBucketSql` is the same rule in SQL.
 */
export function waitBucket(seconds: number): number {
  const w = Math.max(0, Math.floor(seconds));
  if (w < 600) return w;
  if (w < 3_600) return w - (w % 10);
  if (w < 86_400) return w - (w % 60);
  if (w < WEEK) return w - (w % 3_600);
  return WEEK;
}
const WEEK = 7 * 86_400;
export const WAIT_HISTOGRAM_MAX_ROWS = 600 + (3_600 - 600) / 10 + (86_400 - 3_600) / 60 + (WEEK - 86_400) / 3_600 + 1;
const waitBucketSql = (w: SQL) => sql`case when ${w} < 600 then ${w} when ${w} < 3600 then ${w} - ${w} % 10
  when ${w} < 86400 then ${w} - ${w} % 60 when ${w} < ${sql.raw(String(WEEK))} then ${w} - ${w} % 3600
  else ${sql.raw(String(WEEK))} end`;

/**
 * The window's statement (exported for the bounded-rows test): counts by state and error code with their longest wait,
 * and the wait histogram, from one index-only pass over `feed_runs_finished_at_idx` hashed into two grouping sets.
 */
export function finishedStatsSql(since: Date): SQL {
  // The wait once per run (the bucket reads the column; inlined, the expression ran once per CASE arm).
  return sql`
    select grouping(state, error_code) = 3 as waits, state, error_code, bucket, count(*)::int as n,
           max(wait) as max_wait
      from (select state, error_code, wait, ${waitBucketSql(sql.raw('wait'))} as bucket
              from (select state, error_code,
                           greatest(floor(date_part('epoch', started_at - created_at)), 0)::int as wait
                      from feed_runs
                     where finished_at >= ${since.toISOString()}::timestamptz
                    offset 0) w) r
     group by grouping sets ((state, error_code), (bucket))`;
}

/**
 * Runs finished since `since`: counts by state and error code, and the queue wait (start − queued) of those that
 * started — p95 and max, in seconds. S7-F10: one pass, no sort (it was two passes, the p95 one sorting every run of the
 * window: 94 ms at 120k runs, spilling to disk). The max is exact; the p95 is `percentile_cont` over the histogram's
 * buckets (`waitBucket`: exact to the second up to 10 min, then to 10 s, the minute, the hour). `date_part` (float8), not
 * `extract` (numeric: 3× the per-row cost).
 */
export async function finishedStats(
  tx: Tx,
  since: Date,
): Promise<{ outcomes: { state: string; errorCode: string | null; count: number }[]; p95: number; max: number }> {
  const r = await tx.execute<{
    waits: boolean;
    state: string | null;
    error_code: string | null;
    bucket: number | null;
    n: number;
    max_wait: number | null;
  }>(finishedStatsSql(since));
  const histogram = r.rows
    .filter((x) => x.waits && x.bucket !== null)
    .map((x) => ({ value: Number(x.bucket), count: Number(x.n) }));
  return {
    outcomes: r.rows
      .filter((x) => !x.waits)
      .map((x) => ({ state: x.state as string, errorCode: x.error_code, count: Number(x.n) })),
    p95: Math.round(histogramPercentile(histogram, 0.95)),
    max: r.rows.reduce((m, x) => (x.waits ? m : Math.max(m, Number(x.max_wait ?? 0))), 0),
  };
}

/**
 * Staff resume (S6-08): `app_staff` may read and write only the pause and schedule columns of a connection (column
 * grants), never its URL, credentials or settings. Locks the row; null when it does not exist.
 */
export async function lockConnectionForStaff(tx: Tx, connectionId: string) {
  const [row] = await tx
    .select({
      id: feedConnections.id,
      agencyId: feedConnections.agencyId,
      pausedAt: feedConnections.pausedAt,
      pauseReason: feedConnections.pauseReason,
      pauseDetails: feedConnections.pauseDetails,
      pausedRunId: feedConnections.pausedRunId,
      acceptAnomalyOnce: feedConnections.acceptAnomalyOnce,
      nextRunAt: feedConnections.nextRunAt,
      version: feedConnections.version,
    })
    .from(feedConnections)
    .where(eq(feedConnections.id, connectionId))
    .for('update');
  return row ?? null;
}

/** `resumeConnection` for staff: same change plus their reason (S7-F1), answering only the columns staff may read. */
export async function resumeConnectionForStaff(tx: Tx, connectionId: string, acceptChange: boolean, reason: string) {
  const [row] = await tx
    .update(feedConnections)
    .set({
      staffResumeReason: reason,
      pausedAt: null,
      pauseReason: null,
      pauseDetails: null,
      pausedRunId: null,
      acceptAnomalyOnce: acceptChange,
      nextRunAt: sql`case when ${feedConnections.enabled} and ${feedConnections.scheduleMinutes} is not null
        then now() else ${feedConnections.nextRunAt} end`,
      version: sql`${feedConnections.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(feedConnections.id, connectionId))
    .returning({
      id: feedConnections.id,
      pausedAt: feedConnections.pausedAt,
      pauseReason: feedConnections.pauseReason,
      pauseDetails: feedConnections.pauseDetails,
      pausedRunId: feedConnections.pausedRunId,
      acceptAnomalyOnce: feedConnections.acceptAnomalyOnce,
      nextRunAt: feedConnections.nextRunAt,
    });
  return row ?? null;
}

/** Paused connections of every agency, latest first (`feed_connections_paused_idx`). */
export async function pausedConnections(tx: Tx, limit: number) {
  return tx
    .select({
      id: feedConnections.id,
      agencyId: feedConnections.agencyId,
      name: feedConnections.name,
      connector: feedConnections.connector,
      pausedAt: feedConnections.pausedAt,
      pauseReason: feedConnections.pauseReason,
      pauseDetails: feedConnections.pauseDetails,
      pausedRunId: feedConnections.pausedRunId,
    })
    .from(feedConnections)
    .where(sql`${feedConnections.pausedAt} is not null`)
    .orderBy(desc(feedConnections.pausedAt))
    .limit(limit);
}

/** The latest failed runs since `since` (`feed_runs_finished_at_idx`, newest first), with their connector. */
export async function recentFailures(tx: Tx, since: Date, limit: number) {
  const r = await tx.execute<{
    id: string;
    connection_id: string;
    agency_id: string;
    connector: string;
    error_code: string | null;
    finished_at: Date | string;
  }>(sql`
    select r.id, r.connection_id, r.agency_id, c.connector, r.error_code, r.finished_at
      from feed_runs r join feed_connections c on c.id = r.connection_id
     where r.finished_at >= ${since.toISOString()}::timestamptz and r.state = 'FAILED'
     order by r.finished_at desc
     limit ${limit}`);
  return r.rows.map((x) => ({
    runId: x.id,
    connectionId: x.connection_id,
    agencyId: x.agency_id,
    connector: x.connector,
    errorCode: x.error_code ?? 'INTERNAL',
    finishedAt: new Date(x.finished_at),
  }));
}

/** A Postgres text[] literal, one parameter whatever the length (a page holds 40 refs, a batch 500). */
const textArray = (values: readonly string[]) =>
  `{${values.map((v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;

/**
 * S6-F4: the source hashes of `refs` checked since `since` (older ones are not trusted: a weekly full fetch). One
 * primary-key probe per ref.
 */
export async function freshSourceHashes(
  tx: Tx,
  scope: { agencyId: string; connectionId: string },
  refs: readonly string[],
  since: Date,
): Promise<Map<string, string>> {
  if (refs.length === 0) return new Map();
  const rows = await tx
    .select({ ref: feedSourceHashes.externalRef, hash: feedSourceHashes.hash })
    .from(feedSourceHashes)
    .where(
      and(
        eq(feedSourceHashes.agencyId, scope.agencyId),
        eq(feedSourceHashes.connectionId, scope.connectionId),
        sql`${feedSourceHashes.externalRef} = any(${textArray(refs)}::text[])`,
        gt(feedSourceHashes.checkedAt, since),
      ),
    );
  return new Map(rows.map((r) => [r.ref, r.hash]));
}

/**
 * S6-F4, in the batch transaction: `stored` items (written or unchanged by the loader) get their hash with
 * `checked_at` now; `seen` refs (seen-only or failed with a reference) only get this run as their last.
 */
export async function recordSourceHashes(
  tx: Tx,
  scope: { agencyId: string; connectionId: string; runId: string },
  stored: readonly { ref: string; hash: string }[],
  seen: readonly string[],
): Promise<void> {
  if (stored.length > 0) {
    await tx.execute(sql`
      insert into feed_source_hashes (agency_id, connection_id, external_ref, hash, checked_at, last_run_id)
      select ${scope.agencyId}::uuid, ${scope.connectionId}::uuid, r.ref, r.hash, now(), ${scope.runId}::uuid
        from unnest(${textArray(stored.map((s) => s.ref))}::text[], ${textArray(stored.map((s) => s.hash))}::text[])
             as r(ref, hash)
      on conflict (agency_id, connection_id, external_ref)
      do update set hash = excluded.hash, checked_at = excluded.checked_at, last_run_id = excluded.last_run_id`);
  }
  if (seen.length > 0) {
    await tx.execute(sql`
      update feed_source_hashes set last_run_id = ${scope.runId}::uuid
       where agency_id = ${scope.agencyId}::uuid and connection_id = ${scope.connectionId}::uuid
         and external_ref = any(${textArray(seen)}::text[])`);
  }
}

/**
 * S6-F4, in the transaction that ends a successful run: the hashes of references this run did not see go, so a listing
 * that left the feed is fetched in full when it comes back.
 */
export async function pruneSourceHashes(
  tx: Tx,
  scope: { agencyId: string; connectionId: string; runId: string },
): Promise<void> {
  await tx.execute(sql`
    delete from feed_source_hashes
     where agency_id = ${scope.agencyId}::uuid and connection_id = ${scope.connectionId}::uuid
       and last_run_id <> ${scope.runId}::uuid`);
}

/**
 * S9-03: whether a feed run of the agency is queued or running (an import is rewriting its listings). Portal feed
 * passes wait for `imports.run.finished` instead of running every few minutes meanwhile. Served by the small partial
 * index `feed_runs_active_idx` (active runs only).
 */
export async function agencyImportActive(tx: Tx, agencyId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: feedRuns.id })
    .from(feedRuns)
    .where(and(inArray(feedRuns.state, ['QUEUED', 'RUNNING']), eq(feedRuns.agencyId, agencyId)))
    .limit(1);
  return rows.length > 0;
}
