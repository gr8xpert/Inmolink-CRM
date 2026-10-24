import { createHash } from 'node:crypto';
import {
  AppError,
  type CreateTaskBody,
  type ListTasksQuery,
  type TaskDto,
  type TaskPage,
  type UpdateTaskBody,
} from '@inmolink/contracts';
import { withSystem, withTenant } from '@inmolink/db';
import { safeEqual } from '@inmolink/platform/crypto';
import { EmailSendError, mailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as identity from '../identity';
import * as properties from '../properties';
import * as activitiesRepo from './activities-repo';
import { crmEvents } from './events';
import { assertCan } from './policy';
import { renderTaskReminder } from './task-emails';
import * as tasksRepo from './tasks-repo';

/**
 * Tasks and reminders (S10-05, PLAN §7 M8). A task is about a contact, a lead and/or a listing (or nothing), has a due
 * date and an assignee (an active member), and reminds the assignee by e-mail once, at the due time.
 *
 * Reminders — the real guarantee is **at most once per due time**, and exactly once unless a worker dies or the mail
 * provider answers ambiguously between the claim and the send:
 *  1. `crm.sweepTaskReminders` (every minute) claims the open, armed tasks that came due — at most `SWEEP_PER_AGENCY` per
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
 * There is no in-app notification yet (no notifications module): the reminder is an e-mail, and "my tasks" lists what
 * is due. Times are shown in the platform time zone (`DEFAULT_TIME_ZONE`).
 */

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const userIdOf = (ctx: Ctx): string | null => (ctx.actor.kind === 'user' ? ctx.actor.userId : null);
const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;

/** The key's unique index outlives the 24 h replay window: a stale key hits it on insert. */
const isKeyReused = (err: unknown, constraint: string): boolean => {
  const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
  return cause?.code === '23505' && cause.constraint === constraint;
};
/** How long after its due time a task can still be reminded (a longer worker outage skips it). */
export const REMINDER_GRACE_MS = 24 * 3_600_000;
const SWEEP_BATCH = 200;
/** One agency's share of a batch: a backlog in one agency never takes the whole of it. */
const SWEEP_PER_AGENCY = 50;
const SWEEP_MAX_BATCHES = 25;
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
  return toPage(rows, query.limit, (r) => ({ at: r.dueSortMs, id: r.id }), toTaskDto);
}

export async function getTask(ctx: Ctx, id: string): Promise<TaskDto> {
  assertCan(ctx, 'crm.tasks.read');
  const row = await tasksRepo.getTask(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('TASK_NOT_FOUND');
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
  const idempotency = opts.idempotencyKey
    ? { hash: sha256(`crm.task:${userIdOf(ctx)}:${opts.idempotencyKey}`), requestHash: sha256(JSON.stringify(input)) }
    : null;
  if (idempotency) {
    await activitiesRepo.lockIdempotency(ctx.tx, idempotency.hash);
    const prior = await tasksRepo.taskByIdempotency(
      ctx.tx,
      agencyId,
      idempotency.hash,
      new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS),
    );
    if (prior) {
      if (!prior.requestHash || !safeEqual(prior.requestHash, idempotency.requestHash)) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED');
      }
      return { task: toTaskDto(prior.row), replayed: true };
    }
  }

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
    const listing = await properties.leadTargetListing(ctx.tx, agencyId, input.listingId);
    if (!listing || listing.agencyId !== agencyId) throw new AppError('LISTING_NOT_FOUND');
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
    .catch((err: unknown) => {
      if (isKeyReused(err, 'tasks_idempotency_uq')) throw new AppError('IDEMPOTENCY_KEY_REUSED');
      throw err;
    });
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
 * `SWEEP_BATCH × SWEEP_MAX_BATCHES` per pass, oldest due first with at most `SWEEP_PER_AGENCY` of one agency per batch. Each batch is one
 * system transaction: the claim (`reminded_at`) and the outbox events (one per task, tenant = the task's agency) commit
 * together. Returns what it claimed.
 */
export async function sweepTaskReminders(
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<{ claimed: ClaimedTaskReminder[] }> {
  const now = opts.now ?? new Date();
  const claimed: ClaimedTaskReminder[] = [];
  for (let i = 0; i < SWEEP_MAX_BATCHES; i++) {
    if (opts.signal?.aborted) break;
    const batch = await withSystem('crm.sweepTaskReminders', async (tx) => {
      const rows = await tasksRepo.claimDueReminders(tx, now, REMINDER_GRACE_MS, SWEEP_BATCH, SWEEP_PER_AGENCY);
      await emit(
        tx,
        rows.map((r) =>
          crmEvents.taskReminderDue({ agencyId: r.agencyId, taskId: r.id, dueMs: r.dueMs, remindedMs: r.remindedMs }),
        ),
      );
      return rows;
    });
    claimed.push(
      ...batch.map((r) => ({ taskId: r.id, agencyId: r.agencyId, dueMs: r.dueMs, remindedMs: r.remindedMs })),
    );
    // a batch can be short because of the per-agency share: stop only when nothing is left
    if (batch.length === 0) break;
  }
  return { claimed };
}

/** Failures known to precede the send: a message the adapter refused, a provider 4xx refusal. */
const wasNotSent = (err: unknown) => err instanceof TypeError || (err instanceof EmailSendError && err.notSent);

/**
 * `crm.sendTaskReminder`: the e-mail of a claimed reminder (see the guarantee above). Claims the send (system role,
 * the agency named in every statement), looks the assignee up (an active member; gone: nothing is sent), sends outside
 * any transaction with the provider's idempotency key, and gives the claim back only after a failure known to precede
 * the send, so the retry can send.
 */
export async function sendTaskReminder(p: Omit<ClaimedTaskReminder, 'remindedMs'>): Promise<{ sent: boolean }> {
  const task = await withSystem('crm.sendTaskReminder claim', (tx) =>
    tasksRepo.claimReminderSend(tx, p.agencyId, p.taskId, p.dueMs),
  );
  if (!task) return { sent: false };
  let beforeSend = true;
  try {
    const to = await withSystem('crm.sendTaskReminder recipient', (tx) =>
      identity.memberRecipient(tx, p.agencyId, task.assignedUserId),
    );
    if (!to) return { sent: false };
    beforeSend = false;
    await mailer().send({
      ...renderTaskReminder({
        to: to.email,
        name: to.name,
        locale: to.locale,
        title: task.title,
        description: task.description,
        dueAt: task.dueAt,
      }),
      idempotencyKey: `task-reminder:${p.taskId}:${p.dueMs}`,
    });
    return { sent: true };
  } catch (err) {
    if (beforeSend || wasNotSent(err)) {
      await withSystem('crm.sendTaskReminder release', (tx) =>
        tasksRepo.releaseReminderSend(tx, p.agencyId, p.taskId, p.dueMs),
      );
    }
    throw err;
  }
}

/** A purged listing leaves the agency's tasks (they stay, without the listing). */
export async function forgetListingTasks(p: { agencyId: string; listingId: string }): Promise<{ rows: number }> {
  const rows = await withTenant({ agencyId: p.agencyId }, (tx) => tasksRepo.clearListing(tx, p.agencyId, p.listingId));
  return { rows };
}
