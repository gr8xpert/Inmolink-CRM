import type { Tx } from '@inmolink/db';
import { auditLogs } from '@inmolink/db/schema/compliance';
import { and, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { KeysetCursor } from '../../pagination';

/**
 * compliance queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/compliance` — other modules' tables fail `pnpm check:boundaries`.
 */

export interface AuditLogInsert {
  id: string;
  agencyId: string;
  type: string;
  actorKind: 'user' | 'staff' | 'system' | 'apiKey' | 'anonymous';
  actorUserId: string | null;
  impersonatedBy: string | null;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

/**
 * One row; the role's RLS policy decides whose (`audit_logs` registry entry). No RETURNING: app_auth cannot
 * read. The time is the database's (the transaction's start, to the millisecond so keyset cursors round-trip
 * through `Date`): an application clock — faked in tests — could write rows into months whose partition
 * does not exist yet, which would then block partman from creating it.
 */
export async function insertAuditLog(tx: Tx, row: AuditLogInsert): Promise<void> {
  await tx.insert(auditLogs).values({ ...row, occurredAt: sql`date_trunc('milliseconds', now())` });
}

const listColumns = {
  id: auditLogs.id,
  occurredAt: auditLogs.occurredAt,
  type: auditLogs.type,
  actorKind: auditLogs.actorKind,
  actorUserId: auditLogs.actorUserId,
  impersonatedBy: auditLogs.impersonatedBy,
  targetType: auditLogs.targetType,
  targetId: auditLogs.targetId,
  requestId: auditLogs.requestId,
  metadata: auditLogs.metadata,
};

export type AuditLogRow = {
  id: string;
  occurredAt: Date;
  type: string;
  actorKind: string;
  actorUserId: string | null;
  impersonatedBy: string | null;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
};

/**
 * The agency's audit log, newest first: `audit_logs_agency_idx (agency_id, occurred_at, id)` scanned
 * backwards in each monthly partition (merge append), `limit + 1` rows.
 */
export async function listAuditLogs(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<AuditLogRow[]> {
  const { cursor } = page;
  return tx
    .select(listColumns)
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.agencyId, agencyId),
        cursor
          ? or(
              lt(auditLogs.occurredAt, cursor.at),
              and(eq(auditLogs.occurredAt, cursor.at), lt(auditLogs.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
    .limit(page.limit + 1);
}

export type StaffAuditRow = AuditLogRow & { agencyId: string };

/**
 * The staff viewer (S1-09, app_staff reads every row): newest first, keyset ≤ 100, optionally one agency
 * (`audit_logs_agency_idx`), one type (`audit_logs_type_idx`) or neither (`audit_logs_time_idx`), and a
 * time window (`from` inclusive, `to` exclusive) — which also prunes monthly partitions.
 */
export async function listAuditLogsForStaff(
  tx: Tx,
  q: { agencyId?: string; type?: string; from?: Date; to?: Date; limit: number; cursor?: KeysetCursor },
): Promise<StaffAuditRow[]> {
  const { cursor } = q;
  return tx
    .select({ ...listColumns, agencyId: auditLogs.agencyId })
    .from(auditLogs)
    .where(
      and(
        q.agencyId ? eq(auditLogs.agencyId, q.agencyId) : undefined,
        q.type ? eq(auditLogs.type, q.type) : undefined,
        q.from ? gte(auditLogs.occurredAt, q.from) : undefined,
        q.to ? lt(auditLogs.occurredAt, q.to) : undefined,
        cursor
          ? or(
              lt(auditLogs.occurredAt, cursor.at),
              and(eq(auditLogs.occurredAt, cursor.at), lt(auditLogs.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
    .limit(q.limit + 1);
}

/** pg_partman maintenance for every partitioned table (`app_partition_maintenance()`, app_system only). */
export async function runPartitionMaintenance(tx: Tx): Promise<void> {
  await tx.execute(sql`select public.app_partition_maintenance()`);
}

/** The transaction's scope settings (`app.agency_id`, `app.user_id`), to restore after a narrowed insert. */
export async function currentScope(tx: Tx): Promise<{ agencyId?: string; userId?: string }> {
  const r = await tx.execute<{ agency: string | null; usr: string | null }>(
    sql`select nullif(current_setting('app.agency_id', true), '') as agency,
               nullif(current_setting('app.user_id', true), '') as usr`,
  );
  const row = r.rows[0];
  return { agencyId: row?.agency ?? undefined, userId: row?.usr ?? undefined };
}
