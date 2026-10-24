import {
  AppError,
  type CreateTaskBody,
  type ListTasksQuery,
  notificationText,
  type TaskDto,
  type TaskPage,
  type UpdateTaskBody,
} from '@inmolink/contracts';
import { withTenant } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import type { Ctx } from '../../context';
import { idempotencyOf, keyReusedOn, replayOf } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as identity from '../identity';
import * as notifications from '../notifications';
import * as activitiesRepo from './activities-repo';
import { auditImpersonatedRead } from './audit';
import { crmEvents } from './events';
import { linkedListing } from './listing-ref';
import { assertCan } from './policy';
import { sendReminder, sweepReminders } from './reminders';
import { renderTaskReminder } from './task-emails';
import * as tasksRepo from './tasks-repo';

/**
 * Tasks and reminders (S10-05, PLAN §7 M8). A task is about a contact, a lead and/or a listing (or nothing), has a due
 * date and an assignee (an active member), and reminds the assignee by e-mail once, at the due time.
 *
 * Reminders — the real guarantee is **at most once per due time**, and exactly once unless a worker dies or the mail
 * provider answers ambiguously between the claim and the send:
 *  1. `crm.sweepTaskReminders` (every minute) claims the open, armed tasks that came due — at most `REMINDER_SWEEP.perAgency` per
 *     agency per batch, `for update skip locked`, so concurrent sweeps take different rows — sets `reminded_at` and
 *     writes `crm.task.reminderDue` in that transaction;
 *  2. the event becomes one `crm.sendTaskReminder` job (id: task + due time + claim time); the job claims the send
 *     (`reminder_sent_for = due_at`, only for the due time the sweep claimed, open, live, not yet sent for it) and only
 *     then sends, with the provider's idempotency key (task + due time) where the driver has one (Resend). A
 *     redelivered event or a retried job finds the claim taken and sends nothing.
 *  3. The claim is given back only after a failure known to precede the send (a rejected message, a 4xx refusal, a
 *     failed recipient lookup); after a timeout, a 5xx or a dropped connection it is unknown whether the mail went, so the
 *     claim stays: that reminder may be lost (at most once), never doubled.
 *  4. Completing or deleting a task, or moving its due date, stops a reminder still on its way (the claim's
 *     conditions). A new due date, `remind` turned on or a reopened task re-arm it (`reminded_at` cleared by the
 *     service — the one reminder column members write); a due time already reminded is not reminded again. A due date
 *     already past when it is set sends nothing. Reassigning keeps the reminder state (the new assignee is reminded if
 *     the reminder is still to come; not again after it was sent).
 *  5. S12-F2: the send claim's transaction also raises the assignee's `TASK_DUE` notification (in-app only — the
 *     reminder e-mail is the mail; `sourceKey` = task + due time, so a claim given back and taken again raises nothing
 *     more). It is raised even when the e-mail cannot go (no address): the member still sees it in the app.
 * "My tasks" lists what is due. Times are shown in the agency's time zone (`agency_settings.time_zone`, S11-F11).
 */

const userIdOf = (ctx: Ctx): string | null => (ctx.actor.kind === 'user' ? ctx.actor.userId : null);
/** How long after its due time a task can still be reminded (a longer worker outage skips it). */
export const REMINDER_GRACE_MS = 24 * 3_600_000;
const COMPLETED_EXCERPT_CHARS = 280;

export function toTaskDto(row: tasksRepo.TaskRow): TaskDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as TaskDto['status'],
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    remind: row.remind,
    reminderSent: row.dueAt !== null && row.reminderSentFor?.getTime() === row.dueAt.getTime(),
    assignedUserId: row.assignedUserId,
    contactId: row.contactId,
    leadId: row.leadId,
    listingId: row.listingId,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** The assignee must be an active member of the agency. */
async function assertAssignee(ctx: Ctx, userId: string): Promise<void> {
  if (!(await identity.isActiveMember(ctx, userId))) {
    throw new AppError('VALIDATION_FAILED', { field: 'assignedUserId', reason: 'not_a_member' });
  }
}

/** A due date already past is never reminded: it is created "reminded". */
const armedAt = (dueAt: Date | null, now: Date): Date | null =>
  dueAt && dueAt.getTime() <= now.getTime() ? now : null;

/**
 * `GET /v1/crm/tasks`: tasks soonest due first, keyset (≤ 100 per page). One query.
 */
export async function listTasks(ctx: Ctx, query: ListTasksQuery): Promise<TaskPage> {
  assertCan(ctx, 'crm.tasks.read');
  const cursor = decodeCursor(query.cursor);
  const filter: tasksRepo.TaskFilter = { status: query.status };
  if (query.assignee === 'me') {
    // never widen "mine" to everyone's when there is no member to be "me"
    const me = userIdOf(ctx);
    if (!me) throw new AppError('VALIDATION_FAILED', { field: 'assignee' });
    filter.assignee = me;
  } else if (query.assignee !== 'any') filter.assignee = query.assignee;
  if (query.dueFrom) filter.dueFrom = new Date(query.dueFrom);
  if (query.dueTo) filter.dueTo = new Date(query.dueTo);
  if (query.noDue) filter.noDue = true;
  if (query.contactId) filter.contactId = query.contactId;
  if (query.leadId) filter.leadId = query.leadId;
  if (query.listingId) filter.listingId = query.listingId;
  const rows = await tasksRepo.listTasks(
    ctx.tx,
    ctx.tenant.agencyId,
    filter,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  const page = toPage(rows, query.limit, (r) => ({ at: r.dueSortMs, id: r.id }), toTaskDto);
  await auditImpersonatedRead(ctx, 'tasks', { count: page.items.length });
  return page;
}

export async function getTask(ctx: Ctx, id: string): Promise<TaskDto> {
  assertCan(ctx, 'crm.tasks.read');
  const row = await tasksRepo.getTask(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('TASK_NOT_FOUND');
  await auditImpersonatedRead(ctx, 'tasks', { target: { type: 'task', id } });
  return toTaskDto(row);
}

/**
 * `POST /v1/crm/tasks`. Subjects are checked like an activity's (a lead fills in its contact and listing). With an
 * `Idempotency-Key`, a retry by the same member within 24 h with the same body answers the first task; another body is
 * `IDEMPOTENCY_KEY_REUSED` (the key's advisory lock serializes concurrent retries).
 */
export async function createTask(
  ctx: Ctx,
  input: CreateTaskBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ task: TaskDto; replayed: boolean }> {
  assertCan(ctx, 'crm.tasks.write');
  const agencyId = ctx.tenant.agencyId;
  const now = new Date();
  const idempotency = idempotencyOf('crm.task', userIdOf(ctx), opts.idempotencyKey, input);
  const prior = await replayOf(
    ctx.tx,
    idempotency,
    (since, key) => tasksRepo.taskByIdempotency(ctx.tx, agencyId, key.hash, since),
    { lock: true, now },
  );
  if (prior) return { task: toTaskDto(prior.row), replayed: true };

  const assignedUserId = input.assignedUserId ?? userIdOf(ctx);
  if (!assignedUserId) throw new AppError('FORBIDDEN');
  if (assignedUserId !== userIdOf(ctx)) await assertAssignee(ctx, assignedUserId);

  let contactId = input.contactId ?? null;
  let listingId = input.listingId ?? null;
  if (input.leadId) {
    const lead = await activitiesRepo.leadSubjects(ctx.tx, agencyId, input.leadId);
    if (!lead) throw new AppError('LEAD_NOT_FOUND');
    if (contactId && contactId !== lead.contactId) throw new AppError('VALIDATION_FAILED', { field: 'contactId' });
    // a lead's listing is the agency's own listing only (a network target is its owner's, who never sees the client)
    if (listingId && listingId !== lead.listingId) throw new AppError('VALIDATION_FAILED', { field: 'listingId' });
    contactId ??= lead.contactId;
    listingId ??= lead.listingId;
  }
  if (input.contactId && !(await activitiesRepo.contactOpen(ctx.tx, agencyId, input.contactId))) {
    throw new AppError('CONTACT_NOT_FOUND');
  }
  if (input.listingId) {
    await linkedListing(ctx.tx, agencyId, input.listingId, { ownOnly: true });
  }

  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  const row = await tasksRepo
    .insertTask(ctx.tx, {
      id: newId(),
      agencyId,
      title: input.title,
      description: input.description ?? null,
      dueAt,
      remind: input.remind,
      remindedAt: armedAt(dueAt, now),
      assignedUserId,
      createdBy: userIdOf(ctx),
      contactId,
      leadId: input.leadId ?? null,
      listingId,
      idempotencyHash: idempotency?.hash ?? null,
      requestHash: idempotency?.requestHash ?? null,
    })
    .catch(keyReusedOn('tasks_idempotency_uq'));
  return { task: toTaskDto(row), replayed: false };
}

/**
 * `PATCH /v1/crm/tasks/:id` (optimistic `version`). Completing records `TASK_COMPLETED` on the subjects' timelines (in
 * this transaction: crm's own table). Reopening clears the completion. A changed due date, or `remind` turned on,
 * re-arms the reminder.
 */
export async function updateTask(ctx: Ctx, id: string, input: UpdateTaskBody): Promise<TaskDto> {
  assertCan(ctx, 'crm.tasks.write');
  const agencyId = ctx.tenant.agencyId;
  const current = await tasksRepo.getTask(ctx.tx, agencyId, id, { forUpdate: true });
  if (!current) throw new AppError('TASK_NOT_FOUND');
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const now = new Date();
  const patch: tasksRepo.TaskPatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.assignedUserId !== undefined && input.assignedUserId !== current.assignedUserId) {
    if (input.assignedUserId !== userIdOf(ctx)) await assertAssignee(ctx, input.assignedUserId);
    patch.assignedUserId = input.assignedUserId;
  }
  const dueAt = input.dueAt === undefined ? current.dueAt : input.dueAt === null ? null : new Date(input.dueAt);
  const remind = input.remind ?? current.remind;
  const dueChanged = (dueAt?.getTime() ?? null) !== (current.dueAt?.getTime() ?? null);
  if (dueChanged) patch.dueAt = dueAt;
  if (remind !== current.remind) patch.remind = remind;
  const reopened = input.status === 'OPEN' && current.status === 'DONE';
  if (dueChanged || (remind && !current.remind) || reopened) patch.remindedAt = armedAt(dueAt, now);
  let completed = false;
  if (input.status !== undefined && input.status !== current.status) {
    patch.status = input.status;
    if (input.status === 'DONE') {
      completed = true;
      patch.completedAt = now;
      patch.completedByUserId = userIdOf(ctx);
    } else {
      patch.completedAt = null;
      patch.completedByUserId = null;
    }
  }
  if (Object.keys(patch).length === 0) return toTaskDto(current);
  const updated = await tasksRepo.updateTask(ctx.tx, agencyId, id, input.version, patch);
  if (!updated) throw new AppError('VERSION_CONFLICT');
  if (completed && (current.contactId || current.leadId || current.listingId)) {
    await activitiesRepo.insertActivities(ctx.tx, [
      {
        id: newId(),
        agencyId,
        occurredAt: now,
        type: 'TASK_COMPLETED',
        contactId: current.contactId,
        leadId: current.leadId,
        listingId: current.listingId,
        actorUserId: userIdOf(ctx),
        body: Array.from(updated.title).slice(0, COMPLETED_EXCERPT_CHARS).join(''),
        data: { taskId: id },
      },
    ]);
  }
  return toTaskDto(updated);
}

/** `DELETE /v1/crm/tasks/:id`: soft delete; a deleted task never reminds. */
export async function deleteTask(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, 'crm.tasks.write');
  if (!(await tasksRepo.softDeleteTask(ctx.tx, ctx.tenant.agencyId, id))) throw new AppError('TASK_NOT_FOUND');
}

// ---- reminders (worker) ---------------------------------------------------------------------------------------------

export interface ClaimedTaskReminder {
  taskId: string;
  agencyId: string;
  dueMs: number;
  /** When the sweep claimed it (epoch ms). */
  remindedMs: number;
}

/**
 * `crm.sweepTaskReminders`: claims the tasks that came due (within `REMINDER_GRACE_MS`), up to
 * `REMINDER_SWEEP.batch × maxBatches` per pass, oldest due first with at most `perAgency` of one agency per batch. Each batch is one
 * system transaction: the claim (`reminded_at`) and the outbox events (one per task, tenant = the task's agency) commit
 * together. Returns what it claimed.
 */
export async function sweepTaskReminders(
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<{ claimed: ClaimedTaskReminder[] }> {
  const rows = await sweepReminders({
    job: 'crm.sweepTaskReminders',
    ...opts,
    claim: (tx, now, limits) => tasksRepo.claimDueReminders(tx, now, REMINDER_GRACE_MS, limits.batch, limits.perAgency),
    events: (r) =>
      crmEvents.taskReminderDue({ agencyId: r.agencyId, taskId: r.id, dueMs: r.dueMs, remindedMs: r.remindedMs }),
  });
  return {
    claimed: rows.map((r) => ({ taskId: r.id, agencyId: r.agencyId, dueMs: r.dueMs, remindedMs: r.remindedMs })),
  };
}

/**
 * `crm.sendTaskReminder`: the e-mail of a claimed reminder (see the guarantee above; the flow is `sendReminder`).
 */
export function sendTaskReminder(p: Omit<ClaimedTaskReminder, 'remindedMs'>): Promise<{ sent: boolean }> {
  return sendReminder({
    job: 'crm.sendTaskReminder',
    agencyId: p.agencyId,
    claim: async (tx) => {
      const task = await tasksRepo.claimReminderSend(tx, p.agencyId, p.taskId, p.dueMs);
      if (task) {
        await notifications.raiseNotifications(tx, {
          agencyId: p.agencyId,
          type: 'TASK_DUE',
          userIds: [task.assignedUserId],
          params: { subject: notificationText(task.title) || '…' },
          link: '/tasks',
          sourceKey: `crm.task:${p.taskId}:${p.dueMs}`,
          at: new Date(p.dueMs),
          inAppOnly: true,
        });
      }
      return task;
    },
    recipientUserId: (task) => task.assignedUserId,
    render: (task, to, timeZone) =>
      renderTaskReminder({
        to: to.email,
        name: to.name,
        locale: to.locale,
        title: task.title,
        description: task.description,
        dueAt: task.dueAt,
        timeZone,
      }),
    idempotencyKey: `task-reminder:${p.taskId}:${p.dueMs}`,
    release: (tx) => tasksRepo.releaseReminderSend(tx, p.agencyId, p.taskId, p.dueMs),
  });
}

/** A purged listing leaves the agency's tasks (they stay, without the listing). */
export async function forgetListingTasks(p: { agencyId: string; listingId: string }): Promise<{ rows: number }> {
  const rows = await withTenant({ agencyId: p.agencyId }, (tx) => tasksRepo.clearListing(tx, p.agencyId, p.listingId));
  return { rows };
}
