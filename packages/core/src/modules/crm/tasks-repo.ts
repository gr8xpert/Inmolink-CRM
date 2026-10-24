import type { Tx } from '@inmolink/db';
import { tasks } from '@inmolink/db/schema/crm';
import { and, eq, gt, gte, isNull, lt, type SQL, sql } from 'drizzle-orm';
import type { KeysetCursor } from '../../pagination';

/** `due_sort_ms` of a task with no date (year 9999, `to_timestamp(253402214400)`): sorts after every real date. */
export const NO_DUE_SORT_MS = new Date(253_402_214_400_000);

/**
 * Task queries (S10-05). Lists are one keyset on `(due_sort_ms, id)` ascending — the stored millisecond column, so the
 * cursor's row comparison is an index condition under RLS (S10-02 rule; `crm/keyset.ts` is newest-first, tasks run
 * soonest-first).
 */

export const taskColumns = {
  id: tasks.id,
  agencyId: tasks.agencyId,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  dueAt: tasks.dueAt,
  dueSortMs: tasks.dueSortMs,
  remind: tasks.remind,
  remindedAt: tasks.remindedAt,
  reminderSentFor: tasks.reminderSentFor,
  assignedUserId: tasks.assignedUserId,
  contactId: tasks.contactId,
  leadId: tasks.leadId,
  listingId: tasks.listingId,
  completedAt: tasks.completedAt,
  createdAt: tasks.createdAt,
  version: tasks.version,
};
export type TaskRow = {
  id: string;
  agencyId: string;
  title: string;
  description: string | null;
  status: string;
  dueAt: Date | null;
  dueSortMs: Date;
  remind: boolean;
  remindedAt: Date | null;
  reminderSentFor: Date | null;
  assignedUserId: string;
  contactId: string | null;
  leadId: string | null;
  listingId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  version: number;
};

export interface NewTask {
  id: string;
  agencyId: string;
  title: string;
  description: string | null;
  dueAt: Date | null;
  remind: boolean;
  remindedAt: Date | null;
  assignedUserId: string;
  createdBy: string | null;
  contactId: string | null;
  leadId: string | null;
  listingId: string | null;
  idempotencyHash: string | null;
  requestHash: string | null;
}

export async function insertTask(tx: Tx, row: NewTask): Promise<TaskRow> {
  const [created] = await tx.insert(tasks).values(row).returning(taskColumns);
  if (!created) throw new Error('crm: task insert returned no row');
  return created;
}

/** A live (not deleted) task of the agency; `forUpdate` locks the row. */
export async function getTask(
  tx: Tx,
  agencyId: string,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<TaskRow | null> {
  const q = tx
    .select(taskColumns)
    .from(tasks)
    .where(and(eq(tasks.agencyId, agencyId), eq(tasks.id, id), isNull(tasks.deletedAt)));
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

export async function taskByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ row: TaskRow; requestHash: string | null } | null> {
  const [row] = await tx
    .select({ ...taskColumns, requestHash: tasks.requestHash })
    .from(tasks)
    .where(and(eq(tasks.agencyId, agencyId), eq(tasks.idempotencyHash, hash), gt(tasks.createdAt, since)));
  if (!row) return null;
  const { requestHash, ...rest } = row;
  return { row: rest, requestHash };
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: string;
  dueAt?: Date | null;
  remind?: boolean;
  remindedAt?: Date | null;
  assignedUserId?: string;
  completedAt?: Date | null;
  completedByUserId?: string | null;
}

/** Updates under the caller's version; null when the version moved (a concurrent edit). */
export async function updateTask(
  tx: Tx,
  agencyId: string,
  id: string,
  version: number,
  patch: TaskPatch,
): Promise<TaskRow | null> {
  const [row] = await tx
    .update(tasks)
    .set({ ...patch, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
    .where(and(eq(tasks.agencyId, agencyId), eq(tasks.id, id), eq(tasks.version, version), isNull(tasks.deletedAt)))
    .returning(taskColumns);
  return row ?? null;
}

/** Soft delete (a deleted task never reminds). False when it was not there. */
export async function softDeleteTask(tx: Tx, agencyId: string, id: string): Promise<boolean> {
  const rows = await tx
    .update(tasks)
    .set({ deletedAt: new Date(), version: sql`${tasks.version} + 1`, updatedAt: new Date() })
    .where(and(eq(tasks.agencyId, agencyId), eq(tasks.id, id), isNull(tasks.deletedAt)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export interface TaskFilter {
  assignee?: string;
  status: string;
  dueFrom?: Date;
  dueTo?: Date;
  noDue?: boolean;
  contactId?: string;
  leadId?: string;
  listingId?: string;
}

/**
 * One page, soonest due first (undated last): where agency_id = ? [and assigned_user_id = ?] and status = ? and
 * deleted_at is null and (due_sort_ms, id) > (?, ?) order by due_sort_ms, id — `tasks_assignee_idx` / `tasks_agency_idx`
 * (or the subject's index); a due range is a bound on the same column.
 */
export async function listTasks(
  tx: Tx,
  agencyId: string,
  filter: TaskFilter,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<TaskRow[]> {
  const conds: (SQL | undefined)[] = [
    eq(tasks.agencyId, agencyId),
    eq(tasks.status, filter.status),
    isNull(tasks.deletedAt),
  ];
  if (filter.assignee) conds.push(eq(tasks.assignedUserId, filter.assignee));
  if (filter.contactId) conds.push(eq(tasks.contactId, filter.contactId));
  if (filter.leadId) conds.push(eq(tasks.leadId, filter.leadId));
  if (filter.listingId) conds.push(eq(tasks.listingId, filter.listingId));
  // on the sort key itself, so the range and the no-date list are index conditions (a dated task is below the sentinel)
  if (filter.noDue) conds.push(eq(tasks.dueSortMs, NO_DUE_SORT_MS));
  if (filter.dueFrom) conds.push(gte(tasks.dueSortMs, filter.dueFrom), lt(tasks.dueSortMs, NO_DUE_SORT_MS));
  if (filter.dueTo) conds.push(lt(tasks.dueSortMs, filter.dueTo));
  if (page.cursor) {
    conds.push(
      sql`(${tasks.dueSortMs}, ${tasks.id}) > (${page.cursor.at.toISOString()}::timestamptz, ${page.cursor.id}::uuid)`,
    );
  }
  return tx
    .select(taskColumns)
    .from(tasks)
    .where(and(...conds))
    .orderBy(tasks.dueSortMs, tasks.id)
    .limit(page.limit + 1);
}

/**
 * A purged listing leaves the agency's live tasks (the task stays, without the listing; a new version, so an open edit
 * form conflicts). `tasks_listing_idx`.
 */
export async function clearListing(tx: Tx, agencyId: string, listingId: string): Promise<number> {
  const rows = await tx
    .update(tasks)
    .set({ listingId: null, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
    .where(and(eq(tasks.agencyId, agencyId), eq(tasks.listingId, listingId), isNull(tasks.deletedAt)))
    .returning({ id: tasks.id });
  return rows.length;
}

export interface ClaimedReminder {
  id: string;
  agencyId: string;
  dueMs: number;
  /** When the sweep claimed it (epoch ms): part of the send job's id, so a re-armed task's job is a new one. */
  remindedMs: number;
}

/**
 * The reminder sweep's claim (system role, every agency): up to `limit` armed, open tasks that came due within the last
 * `graceMs`, at most `perAgency` of any one agency (an agency with a backlog cannot take the whole batch), oldest due
 * first. The candidates are picked by a window over the partial index, then locked `for update skip locked` (row
 * locks cannot be taken under a window; a concurrent sweep takes others) and marked `reminded_at` — the caller writes
 * their outbox events in the same transaction. One statement.
 */
export async function claimDueReminders(
  tx: Tx,
  now: Date,
  graceMs: number,
  limit: number,
  perAgency: number,
): Promise<ClaimedReminder[]> {
  const since = new Date(now.getTime() - graceMs);
  const res = await tx.execute(sql`
    with candidates as (
      select id from (
        select id, due_at, row_number() over (partition by agency_id order by due_at, id) as n from ${tasks}
         where status = 'OPEN' and remind and reminded_at is null and deleted_at is null
           and due_at <= ${now} and due_at > ${since}) ranked
       where n <= ${perAgency}
       order by due_at, id
       limit ${limit}),
    due as (
      select t.id from ${tasks} t join candidates c on c.id = t.id
       where t.status = 'OPEN' and t.remind and t.reminded_at is null and t.deleted_at is null
         for update of t skip locked)
    update ${tasks} t set reminded_at = ${now}
      from due where t.id = due.id
    returning t.id, t.agency_id, (extract(epoch from t.due_at) * 1000)::bigint as due_ms`);
  return (res.rows as { id: string; agency_id: string; due_ms: string | number }[]).map((r) => ({
    id: r.id,
    agencyId: r.agency_id,
    dueMs: Number(r.due_ms),
    remindedMs: now.getTime(),
  }));
}

export interface ReminderTask {
  title: string;
  description: string | null;
  dueAt: Date;
  assignedUserId: string;
}

/**
 * The send job's claim (system role, the agency named): marks the due time as sent (`reminder_sent_for = due_at`) for a
 * task whose reminder the sweep claimed for exactly this due time, still open, live and not yet sent for it. Null when
 * there is nothing to send (done, deleted, rescheduled, already sent) — the e-mail goes out only for the row this
 * statement returned.
 */
export async function claimReminderSend(
  tx: Tx,
  agencyId: string,
  id: string,
  dueMs: number,
): Promise<ReminderTask | null> {
  const res = await tx.execute(sql`
    update ${tasks} set reminder_sent_for = due_at
     where agency_id = ${agencyId} and id = ${id} and status = 'OPEN' and remind and deleted_at is null
       and reminded_at is not null and due_at is not null and reminder_sent_for is distinct from due_at
       and (extract(epoch from due_at) * 1000)::bigint = ${dueMs}
    returning title, description, due_at, assigned_user_id`);
  const r = res.rows[0] as
    | { title: string; description: string | null; due_at: Date | string; assigned_user_id: string }
    | undefined;
  if (!r) return null;
  return { title: r.title, description: r.description, dueAt: new Date(r.due_at), assignedUserId: r.assigned_user_id };
}

/** Gives the send claim back after a send known not to have gone out (only if the due time is still the one claimed). */
export async function releaseReminderSend(tx: Tx, agencyId: string, id: string, dueMs: number): Promise<void> {
  await tx.execute(sql`
    update ${tasks} set reminder_sent_for = null
     where agency_id = ${agencyId} and id = ${id} and reminder_sent_for is not null
       and (extract(epoch from due_at) * 1000)::bigint = ${dueMs}`);
}
