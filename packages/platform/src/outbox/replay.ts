import { type SQL, sql } from 'drizzle-orm';
import type { SqlExecutor } from './emit';

export interface ReplayFilter {
  ids?: string[];
  type?: string;
  /** created_at >= since */
  since?: Date;
  /** created_at < until */
  until?: Date;
  agencyId?: string;
  /** Only dead-lettered events. */
  deadOnly?: boolean;
}

function where(filter: ReplayFilter): SQL {
  const parts: SQL[] = [sql`processed_at is not null`];
  if (filter.ids?.length)
    parts.push(sql`id in (select (jsonb_array_elements_text(${JSON.stringify(filter.ids)}::jsonb))::uuid)`);
  if (filter.type) parts.push(sql`type = ${filter.type}`);
  if (filter.since) parts.push(sql`created_at >= ${filter.since.toISOString()}::timestamptz`);
  if (filter.until) parts.push(sql`created_at < ${filter.until.toISOString()}::timestamptz`);
  if (filter.agencyId) parts.push(sql`agency_id = ${filter.agencyId}::uuid`);
  if (filter.deadOnly) parts.push(sql`dead_at is not null`);
  return sql.join(parts, sql` and `);
}

function assertNarrowed(filter: ReplayFilter): void {
  const window = filter.since !== undefined && filter.until !== undefined;
  if (!filter.ids?.length && !filter.type && !window && !filter.deadOnly) {
    throw new TypeError('replay: give ids, type, since + until, or deadOnly — refusing to replay the whole outbox');
  }
}

/** Counts events a replay would reset. */
export async function countReplayable(tx: SqlExecutor, filter: ReplayFilter): Promise<number> {
  assertNarrowed(filter);
  const { rows } = await tx.execute(sql`select count(*)::int as n from outbox_events where ${where(filter)}`);
  return Number(rows[0]?.n ?? 0);
}

export interface ReplayBatch {
  replayed: number;
  /** Cursor for the next call; `undefined` when nothing matched. */
  lastId?: string;
}

/**
 * Re-queues up to `limit` processed or dead events matching the filter, in id order after `afterId`
 * (consumers are idempotent, so replay is safe). Loop with the returned cursor until `replayed` is 0 —
 * the cursor keeps a fast dispatcher's re-processed rows from being picked again. Pending rows are
 * untouched; they are delivered anyway.
 */
export async function replayOutboxBatch(
  tx: SqlExecutor,
  filter: ReplayFilter,
  options: { afterId?: string; limit?: number } = {},
): Promise<ReplayBatch> {
  assertNarrowed(filter);
  const after = options.afterId ? sql` and id > ${options.afterId}::uuid` : sql``;
  const { rows } = await tx.execute(sql`
    with picked as (
      select id from outbox_events where ${where(filter)}${after} order by id limit ${options.limit ?? 5_000} for update
    )
    update outbox_events o
       set processed_at = null, dead_at = null, attempts = 0, last_error = null, available_at = now()
      from picked
     where o.id = picked.id
    returning o.id`);
  if (rows.length === 0) return { replayed: 0 };
  const lastId = rows
    .map((r) => String(r.id))
    .sort()
    .at(-1);
  return { replayed: rows.length, lastId };
}
