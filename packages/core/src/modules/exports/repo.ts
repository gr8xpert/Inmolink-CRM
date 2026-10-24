/**
 * exports queries (PATTERNS §5). `app_user` under `withTenant` (dashboard) or `app_system` (workers). Queries only
 * `@inmolink/db/schema/exports`. Every connection query names the agency (RLS would hide other agencies' rows
 * anyway).
 */
import type { PortalFeedRunReason } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import {
  agencyPortalConnections,
  portalChannels,
  portalConnectionIssues,
  portalConnectionProperties,
  portalFeedRuns,
  portalListingSync,
} from '@inmolink/db/schema/exports';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

export type ChannelStatus = (typeof portalChannels.$inferSelect)['status'];
export type SelectionMode = (typeof agencyPortalConnections.$inferSelect)['selectionMode'];
export type OverrideAction = (typeof portalConnectionProperties.$inferSelect)['action'];

export interface ChannelRow {
  code: string;
  name: string;
  status: ChannelStatus;
  credentialFields: string[];
}

const channelColumns = {
  code: portalChannels.code,
  name: portalChannels.name,
  status: portalChannels.status,
  credentialFields: portalChannels.credentialFields,
};

/** The whole catalog (a handful of rows), in display order. */
export async function listChannels(tx: Tx): Promise<ChannelRow[]> {
  return tx.select(channelColumns).from(portalChannels).orderBy(asc(portalChannels.position), asc(portalChannels.code));
}

export async function getChannel(tx: Tx, code: string): Promise<ChannelRow | null> {
  const [row] = await tx.select(channelColumns).from(portalChannels).where(eq(portalChannels.code, code)).limit(1);
  return row ?? null;
}

/** Catalog upsert (`withSystem`): the sync script and tests. */
export async function upsertChannels(tx: Tx, rows: readonly (ChannelRow & { position: number })[]): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(portalChannels)
    .values(rows.map((r) => ({ ...r, credentialFields: [...r.credentialFields] })))
    .onConflictDoUpdate({
      target: portalChannels.code,
      set: {
        name: sql`excluded.name`,
        status: sql`excluded.status`,
        credentialFields: sql`excluded.credential_fields`,
        position: sql`excluded.position`,
      },
    });
}

export interface ConnectionRow {
  id: string;
  agencyId: string;
  channelCode: string;
  name: string;
  enabled: boolean;
  selectionMode: SelectionMode;
  selectionTag: string | null;
  credentialsEnc: string | null;
  credentialKeys: string[];
  tokenHint: string;
  tokenCreatedAt: Date;
  revokedAt: Date | null;
  lastCheckedAt: Date | null;
  lastValidCount: number | null;
  lastInvalidCount: number | null;
  /** S9-04: why the last push run stopped for good (push portals); null: no standing problem. */
  pushError: string | null;
  feedRunId: string | null;
  feedSha256: string | null;
  feedBytes: number | null;
  feedItemCount: number | null;
  feedGeneratedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const connectionColumns = {
  id: agencyPortalConnections.id,
  agencyId: agencyPortalConnections.agencyId,
  channelCode: agencyPortalConnections.channelCode,
  name: agencyPortalConnections.name,
  enabled: agencyPortalConnections.enabled,
  selectionMode: agencyPortalConnections.selectionMode,
  selectionTag: agencyPortalConnections.selectionTag,
  credentialsEnc: agencyPortalConnections.credentialsEnc,
  credentialKeys: agencyPortalConnections.credentialKeys,
  tokenHint: agencyPortalConnections.tokenHint,
  tokenCreatedAt: agencyPortalConnections.tokenCreatedAt,
  revokedAt: agencyPortalConnections.revokedAt,
  lastCheckedAt: agencyPortalConnections.lastCheckedAt,
  lastValidCount: agencyPortalConnections.lastValidCount,
  lastInvalidCount: agencyPortalConnections.lastInvalidCount,
  pushError: agencyPortalConnections.pushError,
  feedRunId: agencyPortalConnections.feedRunId,
  feedSha256: agencyPortalConnections.feedSha256,
  feedBytes: agencyPortalConnections.feedBytes,
  feedItemCount: agencyPortalConnections.feedItemCount,
  feedGeneratedAt: agencyPortalConnections.feedGeneratedAt,
  version: agencyPortalConnections.version,
  createdAt: agencyPortalConnections.createdAt,
  updatedAt: agencyPortalConnections.updatedAt,
};

export interface NewConnection {
  id: string;
  agencyId: string;
  channelCode: string;
  name: string;
  selectionMode: SelectionMode;
  selectionTag: string | null;
  credentialsEnc: string | null;
  credentialKeys: string[];
  tokenHash: string;
  tokenHint: string;
  idempotency?: { hash: string; requestHash: string };
  createdBy: string;
  now: Date;
}

export async function insertConnection(tx: Tx, c: NewConnection): Promise<ConnectionRow> {
  const [row] = await tx
    .insert(agencyPortalConnections)
    .values({
      id: c.id,
      agencyId: c.agencyId,
      channelCode: c.channelCode,
      name: c.name,
      selectionMode: c.selectionMode,
      selectionTag: c.selectionTag,
      credentialsEnc: c.credentialsEnc,
      credentialKeys: c.credentialKeys,
      tokenHash: c.tokenHash,
      tokenHint: c.tokenHint,
      tokenCreatedAt: c.now,
      idempotencyHash: c.idempotency?.hash ?? null,
      idempotencyRequestHash: c.idempotency?.requestHash ?? null,
      idempotencyAt: c.idempotency ? c.now : null,
      createdBy: c.createdBy,
      createdAt: c.now,
      updatedAt: c.now,
    })
    .returning(connectionColumns);
  if (!row) throw new Error('insertConnection: no row returned');
  return row;
}

/** The agency's connection an `Idempotency-Key` hash created (the idempotent create's replay), or null. */
export async function getConnectionByIdempotency(
  tx: Tx,
  agencyId: string,
  idempotencyHash: string,
): Promise<(ConnectionRow & { tokenHash: string; requestHash: string | null; idempotencyAt: Date | null }) | null> {
  const [row] = await tx
    .select({
      ...connectionColumns,
      tokenHash: agencyPortalConnections.tokenHash,
      requestHash: agencyPortalConnections.idempotencyRequestHash,
      idempotencyAt: agencyPortalConnections.idempotencyAt,
    })
    .from(agencyPortalConnections)
    .where(
      and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.idempotencyHash, idempotencyHash)),
    );
  return row ?? null;
}

export async function countConnections(tx: Tx, agencyId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(agencyPortalConnections)
    .where(eq(agencyPortalConnections.agencyId, agencyId));
  return row?.n ?? 0;
}

/** Another connection of the agency to the portal with this name (case-insensitive)? */
export async function nameTaken(
  tx: Tx,
  agencyId: string,
  channelCode: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: agencyPortalConnections.id })
    .from(agencyPortalConnections)
    .where(
      and(
        eq(agencyPortalConnections.agencyId, agencyId),
        eq(agencyPortalConnections.channelCode, channelCode),
        sql`lower(${agencyPortalConnections.name}) = lower(${name})`,
        exceptId ? ne(agencyPortalConnections.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The agency's connections, oldest first (keyset on `(created_at, id)`). */
export async function listConnections(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<ConnectionRow[]> {
  return tx
    .select(connectionColumns)
    .from(agencyPortalConnections)
    .where(
      and(
        eq(agencyPortalConnections.agencyId, agencyId),
        keysetAfter(agencyPortalConnections.createdAt, agencyPortalConnections.id, q.cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrder(agencyPortalConnections.createdAt, agencyPortalConnections.id, 'asc'))
    .limit(q.limit + 1);
}

/** One connection of the agency; `forUpdate` locks it (edits, token changes, per-property choices). */
export async function getConnection(
  tx: Tx,
  agencyId: string,
  id: string,
  forUpdate = false,
): Promise<ConnectionRow | null> {
  const query = tx
    .select(connectionColumns)
    .from(agencyPortalConnections)
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)));
  const [row] = await (forUpdate ? query.for('update') : query);
  return row ?? null;
}

export interface ConnectionFields {
  name: string;
  enabled: boolean;
  selectionMode: SelectionMode;
  selectionTag: string | null;
  credentialsEnc: string | null;
  credentialKeys: string[];
  /** Set to null when the credentials or the on/off state change: the push job tries again. */
  pushError?: null;
}

/** Writes a locked connection's new setup and bumps its version. */
export async function updateConnection(
  tx: Tx,
  agencyId: string,
  id: string,
  fields: ConnectionFields,
  now: Date,
): Promise<ConnectionRow> {
  const [row] = await tx
    .update(agencyPortalConnections)
    .set({ ...fields, version: sql`${agencyPortalConnections.version} + 1`, updatedAt: now })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)))
    .returning(connectionColumns);
  if (!row) throw new Error('updateConnection: no row returned');
  return row;
}

/** Bumps a locked connection's version (its per-property choices changed). */
export async function touchConnection(tx: Tx, agencyId: string, id: string, now: Date): Promise<ConnectionRow> {
  const [row] = await tx
    .update(agencyPortalConnections)
    .set({ version: sql`${agencyPortalConnections.version} + 1`, updatedAt: now })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)))
    .returning(connectionColumns);
  if (!row) throw new Error('touchConnection: no row returned');
  return row;
}

/** A new token (rotation; also revives a revoked connection's token). */
export async function setToken(
  tx: Tx,
  agencyId: string,
  id: string,
  t: { tokenHash: string; tokenHint: string; now: Date },
): Promise<ConnectionRow> {
  const [row] = await tx
    .update(agencyPortalConnections)
    .set({
      tokenHash: t.tokenHash,
      tokenHint: t.tokenHint,
      tokenCreatedAt: t.now,
      revokedAt: null,
      version: sql`${agencyPortalConnections.version} + 1`,
      updatedAt: t.now,
    })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)))
    .returning(connectionColumns);
  if (!row) throw new Error('setToken: no row returned');
  return row;
}

export async function revokeToken(tx: Tx, agencyId: string, id: string, now: Date): Promise<ConnectionRow> {
  const [row] = await tx
    .update(agencyPortalConnections)
    .set({ revokedAt: now, version: sql`${agencyPortalConnections.version} + 1`, updatedAt: now })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)))
    .returning(connectionColumns);
  if (!row) throw new Error('revokeToken: no row returned');
  return row;
}

/** Deletes a connection (its per-property choices cascade). */
export async function deleteConnection(tx: Tx, agencyId: string, id: string): Promise<void> {
  await tx
    .delete(agencyPortalConnections)
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)));
}

// ── Per-property choices ───────────────────────────────────────────────────────────────────────────────────────

/** INCLUDE / EXCLUDE counts of these connections: one grouped statement. */
export async function overrideCounts(
  tx: Tx,
  agencyId: string,
  connectionIds: readonly string[],
): Promise<Map<string, { include: number; exclude: number }>> {
  const out = new Map<string, { include: number; exclude: number }>();
  if (connectionIds.length === 0) return out;
  const rows = await tx
    .select({
      connectionId: portalConnectionProperties.connectionId,
      action: portalConnectionProperties.action,
      n: count(),
    })
    .from(portalConnectionProperties)
    .where(
      and(
        eq(portalConnectionProperties.agencyId, agencyId),
        inArray(portalConnectionProperties.connectionId, [...connectionIds]),
      ),
    )
    .groupBy(portalConnectionProperties.connectionId, portalConnectionProperties.action);
  for (const r of rows) {
    const entry = out.get(r.connectionId) ?? { include: 0, exclude: 0 };
    if (r.action === 'INCLUDE') entry.include = r.n;
    else entry.exclude = r.n;
    out.set(r.connectionId, entry);
  }
  return out;
}

/** The current choices among these listings of a connection. */
export async function overridesOf(
  tx: Tx,
  connectionId: string,
  propertyIds: readonly string[],
): Promise<{ propertyId: string; action: OverrideAction }[]> {
  if (propertyIds.length === 0) return [];
  return tx
    .select({ propertyId: portalConnectionProperties.propertyId, action: portalConnectionProperties.action })
    .from(portalConnectionProperties)
    .where(
      and(
        eq(portalConnectionProperties.connectionId, connectionId),
        inArray(portalConnectionProperties.propertyId, [...propertyIds]),
      ),
    );
}

export async function upsertOverrides(
  tx: Tx,
  rows: readonly {
    connectionId: string;
    propertyId: string;
    agencyId: string;
    action: OverrideAction;
    createdBy: string;
    now: Date;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(portalConnectionProperties)
    .values(
      rows.map((r) => ({
        connectionId: r.connectionId,
        propertyId: r.propertyId,
        agencyId: r.agencyId,
        action: r.action,
        createdBy: r.createdBy,
        createdAt: r.now,
      })),
    )
    .onConflictDoUpdate({
      target: [portalConnectionProperties.connectionId, portalConnectionProperties.propertyId],
      set: { action: sql`excluded.action`, createdBy: sql`excluded.created_by`, createdAt: sql`excluded.created_at` },
    });
}

export async function deleteOverrides(tx: Tx, connectionId: string, propertyIds: readonly string[]): Promise<void> {
  if (propertyIds.length === 0) return;
  await tx
    .delete(portalConnectionProperties)
    .where(
      and(
        eq(portalConnectionProperties.connectionId, connectionId),
        inArray(portalConnectionProperties.propertyId, [...propertyIds]),
      ),
    );
}

/**
 * The connection's choices of one kind, ascending by listing id after `after` at most `limit`: `portal_connection_properties_action_idx`. `action` null: both kinds (the dashboard list).
 */
export async function overrideIdPage(
  tx: Tx,
  connectionId: string,
  q: { action: OverrideAction | null; after: string | null; limit: number },
): Promise<{ propertyId: string; action: OverrideAction }[]> {
  return tx
    .select({ propertyId: portalConnectionProperties.propertyId, action: portalConnectionProperties.action })
    .from(portalConnectionProperties)
    .where(
      and(
        eq(portalConnectionProperties.connectionId, connectionId),
        q.action ? eq(portalConnectionProperties.action, q.action) : undefined,
        q.after ? gt(portalConnectionProperties.propertyId, q.after) : undefined,
      ),
    )
    .orderBy(asc(portalConnectionProperties.propertyId))
    .limit(q.limit);
}

// ── Feed validation (S9-02) ───────────────────────────────────────────────────────────────────────────────────────

export interface IssueRow {
  propertyId: string;
  errors: unknown;
  checkedAt: Date;
}

/**
 * A checked batch (worker): writes the batch's failures and removes the rows of listings in its key range that no
 * longer fail. A failure whose reasons are unchanged is not written (`on conflict ... where errors is distinct`), so a
 * second run over unchanged data writes nothing. The range is `(after, upTo]` — `upTo` null: to the end — exactly the
 * ids the selection examined for this batch, so listings no longer selected (or fixed) lose their row without a sweep.
 * Every statement names the agency (these run as `app_system`).
 */
export async function syncIssues(
  tx: Tx,
  connection: { id: string; agencyId: string },
  range: { after: string | null; upTo: string | null },
  failures: readonly { propertyId: string; errors: unknown }[],
  checkedAt: Date,
): Promise<void> {
  const failedIds = failures.map((f) => f.propertyId);
  await tx
    .delete(portalConnectionIssues)
    .where(
      and(
        eq(portalConnectionIssues.agencyId, connection.agencyId),
        eq(portalConnectionIssues.connectionId, connection.id),
        range.after ? gt(portalConnectionIssues.propertyId, range.after) : undefined,
        range.upTo ? lte(portalConnectionIssues.propertyId, range.upTo) : undefined,
        failedIds.length > 0 ? notInArray(portalConnectionIssues.propertyId, failedIds) : undefined,
      ),
    );
  if (failures.length === 0) return;
  await tx
    .insert(portalConnectionIssues)
    .values(
      failures.map((f) => ({
        connectionId: connection.id,
        agencyId: connection.agencyId,
        propertyId: f.propertyId,
        errors: f.errors,
        checkedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [portalConnectionIssues.connectionId, portalConnectionIssues.propertyId],
      set: { errors: sql`excluded.errors`, checkedAt: sql`excluded.checked_at` },
      setWhere: sql`${portalConnectionIssues.errors} is distinct from excluded.errors`,
    });
}

/** Records the last run's outcome on the connection. Does not touch `version` (worker state, not a setup change). */
export async function setValidationSummary(
  tx: Tx,
  agencyId: string,
  id: string,
  summary: { checkedAt: Date; valid: number; invalid: number },
): Promise<void> {
  await tx
    .update(agencyPortalConnections)
    .set({ lastCheckedAt: summary.checkedAt, lastValidCount: summary.valid, lastInvalidCount: summary.invalid })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)));
}

/** A page of the connection's issues by listing id (keyset); one extra row tells whether more follow. */
export async function issuePage(
  tx: Tx,
  connectionId: string,
  q: { after: string | null; limit: number },
): Promise<IssueRow[]> {
  return tx
    .select({
      propertyId: portalConnectionIssues.propertyId,
      errors: portalConnectionIssues.errors,
      checkedAt: portalConnectionIssues.checkedAt,
    })
    .from(portalConnectionIssues)
    .where(
      and(
        eq(portalConnectionIssues.connectionId, connectionId),
        q.after ? gt(portalConnectionIssues.propertyId, q.after) : undefined,
      ),
    )
    .orderBy(asc(portalConnectionIssues.propertyId))
    .limit(q.limit);
}

// ── Feed generation and delivery (S9-03) ──────────────────────────────────────────────────────────────────────────

/**
 * Worker: the agency's connections a pass writes — these ids, or (`ids` null) every live one (enabled, token not
 * revoked; `agency_portal_connections_live_idx`). At most `MAX_PORTAL_CONNECTIONS` rows.
 */
export async function connectionsForPass(
  tx: Tx,
  agencyId: string,
  ids: readonly string[] | null,
): Promise<ConnectionRow[]> {
  if (ids !== null && ids.length === 0) return [];
  return tx
    .select(connectionColumns)
    .from(agencyPortalConnections)
    .where(
      and(
        eq(agencyPortalConnections.agencyId, agencyId),
        ids === null
          ? and(eq(agencyPortalConnections.enabled, true), isNull(agencyPortalConnections.revokedAt))
          : inArray(agencyPortalConnections.id, [...ids]),
      ),
    )
    .orderBy(asc(agencyPortalConnections.id));
}

/** Every connection id of the agency (≤ `MAX_PORTAL_CONNECTIONS`): its edge copies are purged on a status change. */
export async function connectionIdsOf(tx: Tx, agencyId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: agencyPortalConnections.id })
    .from(agencyPortalConnections)
    .where(eq(agencyPortalConnections.agencyId, agencyId));
  return rows.map((r) => r.id);
}

/** Whether the agency has a live connection (an index probe): listing events of other agencies queue nothing. */
export async function hasLiveConnection(tx: Tx, agencyId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: agencyPortalConnections.id })
    .from(agencyPortalConnections)
    .where(
      and(
        eq(agencyPortalConnections.agencyId, agencyId),
        eq(agencyPortalConnections.enabled, true),
        isNull(agencyPortalConnections.revokedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The nightly lane of an agency (0 … lanes - 1): a stable hash of its id, so the agencies split evenly whatever their
 * id order. SQL, so the lane's next agency is found in one statement.
 */
const laneOf = (lanes: number) =>
  sql`mod(hashtext(${agencyPortalConnections.agencyId}::text)::bigint + 2147483648, ${lanes})`;

const nightlyDue = (before: Date) =>
  and(
    eq(agencyPortalConnections.enabled, true),
    isNull(agencyPortalConnections.revokedAt),
    or(isNull(agencyPortalConnections.nightlyAt), lt(agencyPortalConnections.nightlyAt, before)),
  );

/**
 * Nightly lanes (S9-03 review): the first agency of each lane still due tonight (a live connection with no full pass
 * since `before`), in agency-id order. One statement over the partial live index (≤ connections rows).
 */
export async function firstNightlyAgencies(
  tx: Tx,
  q: { before: Date; lanes: number },
): Promise<{ lane: number; agencyId: string }[]> {
  const res = await tx.execute<{ lane: string | number; agency_id: string }>(sql`
    select distinct on (lane) lane, agency_id
      from (select ${laneOf(q.lanes)} as lane, ${agencyPortalConnections.agencyId} as agency_id
              from ${agencyPortalConnections}
             where ${nightlyDue(q.before)}) s
     order by lane, agency_id`);
  return res.rows.map((r) => ({ lane: Number(r.lane), agencyId: r.agency_id }));
}

/** The lane's next agency due tonight after `after` (keyset by agency id), or null: the lane is done. */
export async function nextNightlyAgency(
  tx: Tx,
  q: { before: Date; lanes: number; lane: number; after: string },
): Promise<string | null> {
  const [row] = await tx
    .select({ agencyId: agencyPortalConnections.agencyId })
    .from(agencyPortalConnections)
    .where(
      and(nightlyDue(q.before), gt(agencyPortalConnections.agencyId, q.after), sql`${laneOf(q.lanes)} = ${q.lane}`),
    )
    .orderBy(asc(agencyPortalConnections.agencyId))
    .limit(1);
  return row?.agencyId ?? null;
}

export type FeedRunStatus = (typeof portalFeedRuns.$inferSelect)['status'];
export type FeedRunTrigger = (typeof portalFeedRuns.$inferSelect)['trigger'];

export interface FeedRunRecord {
  /** UUIDv7 allocated when the pass started: a connection's runs sort by start. */
  id: string;
  agencyId: string;
  connectionId: string;
  trigger: FeedRunTrigger;
  status: FeedRunStatus;
  startedAt: Date;
  finishedAt: Date;
  validCount: number | null;
  invalidCount: number | null;
  bytes: number | null;
  sha256: string | null;
  reason: PortalFeedRunReason | null;
}

/**
 * Records a pass's runs (worker, one transaction, three statements whatever the connection count):
 *
 * 1. one UPDATE of the connections (`jsonb_to_recordset`): the nightly mark (`nightly_at`, for a full pass — every
 *    live connection, NIGHTLY or not), the validation totals of a completed run (WRITTEN, UNCHANGED), and — for a
 *    WRITTEN run — the served file, but only if the served file is still `expectedRunId` (compare-and-set; set
 *    expressions read the row as locked, re-read after a concurrent update). `RETURNING` tells which WRITTEN runs won;
 * 2. one INSERT of the history rows: a WRITTEN run that lost is stored as FAILED `SUPERSEDED` (no size, no hash: its
 *    object is deleted);
 * 3. one DELETE of the history beyond the newest `keep` of each of the pass's connections.
 *
 * Returns, per run, the recorded run and the object no longer served (`stale`): the previous file of a run that won,
 * the run's own object when it lost.
 */
export async function recordFeedRuns(
  tx: Tx,
  agencyId: string,
  runs: readonly { run: FeedRunRecord; expectedRunId: string | null }[],
  opts: { keep: number; fullPass: boolean },
): Promise<{ run: FeedRunRecord; stale: string | null }[]> {
  if (runs.length === 0) return [];
  const rows = runs.map(({ run, expectedRunId }) => ({
    connection_id: run.connectionId,
    run_id: run.id,
    expected: expectedRunId,
    written: run.status === 'WRITTEN',
    completed: run.status === 'WRITTEN' || run.status === 'UNCHANGED',
    nightly: opts.fullPass || run.trigger === 'NIGHTLY',
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt.toISOString(),
    valid: run.validCount,
    invalid: run.invalidCount,
    bytes: run.bytes,
    sha: run.sha256,
  }));
  const updated = await tx.execute<{ id: string; served: string | null }>(sql`
    update ${agencyPortalConnections} c
       set nightly_at = case when v.nightly then v.started_at else c.nightly_at end,
           last_checked_at = case when v.completed then v.started_at else c.last_checked_at end,
           last_valid_count = case when v.completed then v.valid else c.last_valid_count end,
           last_invalid_count = case when v.completed then v.invalid else c.last_invalid_count end,
           feed_run_id = case when v.written and c.feed_run_id is not distinct from v.expected
                              then v.run_id else c.feed_run_id end,
           feed_sha256 = case when v.written and c.feed_run_id is not distinct from v.expected
                              then v.sha else c.feed_sha256 end,
           feed_bytes = case when v.written and c.feed_run_id is not distinct from v.expected
                             then v.bytes else c.feed_bytes end,
           feed_item_count = case when v.written and c.feed_run_id is not distinct from v.expected
                                  then v.valid else c.feed_item_count end,
           feed_generated_at = case when v.written and c.feed_run_id is not distinct from v.expected
                                    then v.finished_at else c.feed_generated_at end
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(
             connection_id uuid, run_id uuid, expected uuid, written boolean, completed boolean, nightly boolean,
             started_at timestamptz, finished_at timestamptz, valid integer, invalid integer, bytes integer, sha text)
     where c.agency_id = ${agencyId} and c.id = v.connection_id
     returning c.id, c.feed_run_id as served`);
  const served = new Map(updated.rows.map((r) => [r.id, r.served]));
  const out = runs.map(({ run, expectedRunId }) => {
    if (run.status !== 'WRITTEN') return { run, stale: null };
    if (served.get(run.connectionId) === run.id) return { run, stale: expectedRunId };
    const lost: FeedRunRecord = { ...run, status: 'FAILED', reason: 'SUPERSEDED', bytes: null, sha256: null };
    return { run: lost, stale: run.id };
  });
  // A connection deleted meanwhile has no row to attach history to (the FK would refuse it).
  const recordable = out.filter((o) => served.has(o.run.connectionId));
  if (recordable.length > 0) await tx.insert(portalFeedRuns).values(recordable.map((o) => o.run));
  const ids = [...new Set(recordable.map((o) => o.run.connectionId))];
  if (ids.length > 0) {
    // Retention: the newest `keep` runs of each connection (index (agency_id, connection_id, id); ids are UUIDv7).
    await tx.execute(sql`
      delete from ${portalFeedRuns} r
       using (select k.id as connection_id,
                     (select x.id from ${portalFeedRuns} x
                       where x.agency_id = ${agencyId} and x.connection_id = k.id
                       order by x.id desc offset ${opts.keep - 1} limit 1) as cutoff
                from (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid as id) k) k
       where r.agency_id = ${agencyId} and r.connection_id = k.connection_id and r.id < k.cutoff`);
  }
  return out;
}

/**
 * Worker: forgets the served file of a connection (so a revived one regenerates its file instead of pointing at
 * deleted objects). Without `force`, only when it is no longer live (turned off or token revoked); with `force`
 * (S9-03 review: the portal's writer is off, the agency is not verified) whatever its state. True: nothing is served
 * any more (gone, forgotten).
 */
export async function forgetFeedFile(tx: Tx, agencyId: string, id: string, force = false): Promise<boolean> {
  const where = and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id));
  const [row] = await tx
    .select({ enabled: agencyPortalConnections.enabled, revokedAt: agencyPortalConnections.revokedAt })
    .from(agencyPortalConnections)
    .where(where)
    .for('update');
  if (!row) return true;
  if (!force && row.enabled && row.revokedAt === null) return false;
  await tx
    .update(agencyPortalConnections)
    .set({ feedRunId: null, feedSha256: null, feedBytes: null, feedItemCount: null, feedGeneratedAt: null })
    .where(where);
  return true;
}

/** The connection's latest runs, newest first (ids are allocated when a pass starts: start order). */
export async function feedRuns(tx: Tx, agencyId: string, connectionId: string, limit: number) {
  return tx
    .select({
      id: portalFeedRuns.id,
      trigger: portalFeedRuns.trigger,
      status: portalFeedRuns.status,
      startedAt: portalFeedRuns.startedAt,
      finishedAt: portalFeedRuns.finishedAt,
      validCount: portalFeedRuns.validCount,
      invalidCount: portalFeedRuns.invalidCount,
      bytes: portalFeedRuns.bytes,
      reason: portalFeedRuns.reason,
    })
    .from(portalFeedRuns)
    .where(and(eq(portalFeedRuns.agencyId, agencyId), eq(portalFeedRuns.connectionId, connectionId)))
    .orderBy(desc(portalFeedRuns.id))
    .limit(limit);
}

export interface ServedFeedRow {
  connectionId: string;
  channelCode: string;
  runId: string;
  sha256: string;
}

/**
 * feed-api (`app_public`): the served file of the live connection with this token hash, through the SECURITY DEFINER
 * `portal_feed_by_token` (app_public reads no connection column itself; the function answers only these four). One
 * statement.
 */
export async function feedByTokenHash(tx: Tx, tokenHash: string): Promise<ServedFeedRow | null> {
  const res = await tx.execute<{ connection_id: string; channel_code: string; run_id: string; sha256: string }>(
    sql`select connection_id, channel_code, run_id, sha256 from portal_feed_by_token(${tokenHash})`,
  );
  const row = res.rows[0];
  if (!row) return null;
  return { connectionId: row.connection_id, channelCode: row.channel_code, runId: row.run_id, sha256: row.sha256 };
}

// -- Push portals (S9-04) ------------------------------------------------------------------------------------------

export type SyncState = (typeof portalListingSync.$inferSelect)['state'];

export interface SyncRow {
  propertyId: string;
  state: SyncState;
  remoteId: string | null;
  payloadHash: string;
  errorCode: string | null;
}

/**
 * The connection's sync rows with a listing id in `(after, upTo]` (`upTo` null: to the end) - exactly the range one
 * selection round examined, so the rows there that the selection did not return are the ones to withdraw. One
 * statement, primary-key range. Bounded by the listings the connection ever pushed in the range.
 */
export async function syncRowsInRange(
  tx: Tx,
  agencyId: string,
  connectionId: string,
  range: { after: string | null; upTo: string | null },
): Promise<SyncRow[]> {
  return tx
    .select({
      propertyId: portalListingSync.propertyId,
      state: portalListingSync.state,
      remoteId: portalListingSync.remoteId,
      payloadHash: portalListingSync.payloadHash,
      errorCode: portalListingSync.errorCode,
    })
    .from(portalListingSync)
    .where(
      and(
        eq(portalListingSync.agencyId, agencyId),
        eq(portalListingSync.connectionId, connectionId),
        range.after ? gt(portalListingSync.propertyId, range.after) : undefined,
        range.upTo ? lte(portalListingSync.propertyId, range.upTo) : undefined,
      ),
    )
    .orderBy(asc(portalListingSync.propertyId));
}

export interface SyncWrite extends SyncRow {
  errorCode: string | null;
  syncedAt: Date;
}

/** Records the outcome of pushes (one statement). Idempotent: the row is replaced. */
export async function upsertSyncRows(
  tx: Tx,
  agencyId: string,
  connectionId: string,
  rows: readonly SyncWrite[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(portalListingSync)
    .values(rows.map((r) => ({ ...r, agencyId, connectionId })))
    .onConflictDoUpdate({
      target: [portalListingSync.connectionId, portalListingSync.propertyId],
      set: {
        state: sql`excluded.state`,
        remoteId: sql`excluded.remote_id`,
        payloadHash: sql`excluded.payload_hash`,
        errorCode: sql`excluded.error_code`,
        syncedAt: sql`excluded.synced_at`,
      },
    });
}

/** A pass that covered push connections counts as the night's run for them (they write no feed run). */
export async function markNightly(tx: Tx, agencyId: string, ids: readonly string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(agencyPortalConnections)
    .set({ nightlyAt: at })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), inArray(agencyPortalConnections.id, [...ids])));
}

/** The error code a refused withdrawal is stored with: the advert is still up, and is not asked to come down again. */
export const WITHDRAW_REJECTED = 'WITHDRAW_REJECTED';

/**
 * Adverts of the connection that are still up and may be taken down: a remote id, any state but WITHDRAWN, not a
 * refused withdrawal. A page by listing id (teardown: the connection is off, unflagged or its agency unverified).
 * Processed rows leave the set, so the next page is read from the start.
 */
export async function liveAdverts(tx: Tx, agencyId: string, connectionId: string, limit: number): Promise<SyncRow[]> {
  return tx
    .select({
      propertyId: portalListingSync.propertyId,
      state: portalListingSync.state,
      remoteId: portalListingSync.remoteId,
      payloadHash: portalListingSync.payloadHash,
      errorCode: portalListingSync.errorCode,
    })
    .from(portalListingSync)
    .where(
      and(
        eq(portalListingSync.agencyId, agencyId),
        eq(portalListingSync.connectionId, connectionId),
        isNotNull(portalListingSync.remoteId),
        ne(portalListingSync.state, 'WITHDRAWN'),
        sql`${portalListingSync.errorCode} is distinct from ${WITHDRAW_REJECTED}`,
      ),
    )
    .orderBy(asc(portalListingSync.propertyId))
    .limit(limit);
}

/** Whether the connection still has an advert up at its portal (a delete is refused until they are withdrawn). */
export async function hasLiveAdverts(tx: Tx, agencyId: string, connectionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(portalListingSync)
    .where(
      and(
        eq(portalListingSync.agencyId, agencyId),
        eq(portalListingSync.connectionId, connectionId),
        isNotNull(portalListingSync.remoteId),
        ne(portalListingSync.state, 'WITHDRAWN'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The push job's view of its connections in one statement: the credentials envelope and the standing stop. */
export async function pushStateOf(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
): Promise<Map<string, { credentialsEnc: string | null; pushError: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: agencyPortalConnections.id,
      credentialsEnc: agencyPortalConnections.credentialsEnc,
      pushError: agencyPortalConnections.pushError,
    })
    .from(agencyPortalConnections)
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), inArray(agencyPortalConnections.id, [...ids])));
  return new Map(rows.map((r) => [r.id, { credentialsEnc: r.credentialsEnc, pushError: r.pushError }]));
}

/** Records (or clears) the standing stop of a push connection. Worker state: `version` stays. */
export async function setPushError(tx: Tx, agencyId: string, id: string, code: string | null): Promise<void> {
  await tx
    .update(agencyPortalConnections)
    .set({ pushError: code })
    .where(and(eq(agencyPortalConnections.agencyId, agencyId), eq(agencyPortalConnections.id, id)));
}

/** Whether the agency has a connection to any of these channels (an index probe). */
export async function hasChannelConnection(tx: Tx, agencyId: string, codes: readonly string[]): Promise<boolean> {
  if (codes.length === 0) return false;
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(agencyPortalConnections)
    .where(
      and(eq(agencyPortalConnections.agencyId, agencyId), inArray(agencyPortalConnections.channelCode, [...codes])),
    )
    .limit(1);
  return row !== undefined;
}
