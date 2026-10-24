/**
 * CRM tasks and reminders (S10-05, PLAN §7 M8): an agent's to-dos about a contact, a lead and/or a listing, with a due
 * date, an assignee and an e-mail reminder at the due time. Internal to the agency: nothing here is open in Client Mode.
 */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';

export const TASK_STATUSES = ['OPEN', 'DONE'] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const CRM_TASK_LIMITS = { titleChars: 200, descriptionChars: 4_000 } as const;

/** Control characters and line / paragraph separators: a title is one clean line, a description may break lines. */
const TITLE_BAD = /[\p{Cc}\u2028\u2029]/u;
const TEXT_BAD = /(?![\n\r\t])\p{Cc}|[\u2028\u2029]/u;
const taskTitle = z
  .string()
  .trim()
  .min(1)
  .max(CRM_TASK_LIMITS.titleChars)
  .refine((v) => !TITLE_BAD.test(v), { message: 'no control characters' });
const taskText = z
  .string()
  .trim()
  .min(1)
  .max(CRM_TASK_LIMITS.descriptionChars)
  .refine((v) => !TEXT_BAD.test(v), { message: 'no control characters' });
/** Dates before year 9000 (undated tasks sort at year 9999 in the database). */
const dueDate = z.iso
  .datetime()
  .refine((v) => new Date(v).getTime() < Date.UTC(9000, 0, 1), { message: 'too far ahead' });

export const TaskDto = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskStatus,
  /** Null: no date (listed last). */
  dueAt: z.iso.datetime().nullable(),
  /** Remind the assignee by e-mail at `dueAt`. */
  remind: z.boolean(),
  /** The reminder for the current `dueAt` has been sent. */
  reminderSent: z.boolean(),
  assignedUserId: z.uuid(),
  contactId: z.uuid().nullable(),
  leadId: z.uuid().nullable(),
  listingId: z.uuid().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  version: z.number().int(),
});
export type TaskDto = z.infer<typeof TaskDto>;
export const TaskPage = pageOf(TaskDto);
export type TaskPage = z.infer<typeof TaskPage>;

export const TaskParams = z.strictObject({ id: z.uuid() });
export type TaskParams = z.infer<typeof TaskParams>;

/**
 * `GET /v1/crm/tasks`: tasks by due date (soonest first, undated last), keyset (≤ 100 per page). `assignee`: `me` (the
 * default: my tasks), `any` (the agency's) or a member's id. `status` defaults to `OPEN`. `dueFrom` / `dueTo` bound the
 * due date (inclusive from, exclusive to — the client's day boundaries, so time zones are the client's); `noDue` lists
 * undated tasks only. `contactId`, `leadId` or `listingId` narrow to one subject.
 */
export const ListTasksQuery = PageQuery.extend({
  assignee: z.union([z.literal('me'), z.literal('any'), z.uuid()]).default('me'),
  status: TaskStatus.default('OPEN'),
  dueFrom: dueDate.optional(),
  dueTo: z.iso.datetime().optional(),
  noDue: z.stringbool().optional(),
  contactId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  listingId: z.uuid().optional(),
}).refine((q) => !q.noDue || (q.dueFrom === undefined && q.dueTo === undefined), {
  message: 'noDue excludes dueFrom and dueTo',
  path: ['noDue'],
});
export type ListTasksQuery = z.infer<typeof ListTasksQuery>;
export type ListTasksInput = z.input<typeof ListTasksQuery>;

/**
 * `POST /v1/crm/tasks`. Without `assignedUserId` the task is the caller's. A lead's task also names the lead's contact
 * and listing. A due date already past sends no reminder. Accepts an `Idempotency-Key` (24 h replay of the same body;
 * another body with the key is `IDEMPOTENCY_KEY_REUSED`).
 */
export const CreateTaskBody = z.strictObject({
  title: taskTitle,
  description: taskText.optional(),
  dueAt: dueDate.optional(),
  remind: z.boolean().default(true),
  assignedUserId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  listingId: z.uuid().optional(),
});
export type CreateTaskBody = z.infer<typeof CreateTaskBody>;
export type CreateTaskInput = z.input<typeof CreateTaskBody>;

/**
 * `PATCH /v1/crm/tasks/:id` (optimistic `version`). Completing (`status: DONE`) records `TASK_COMPLETED` on the
 * subjects' timelines. A new `dueAt` (or `remind` turned on) re-arms the reminder. `null` clears the date / description.
 */
export const UpdateTaskBody = z
  .strictObject({
    version: z.number().int().min(1),
    title: taskTitle.optional(),
    description: taskText.nullable().optional(),
    dueAt: dueDate.nullable().optional(),
    remind: z.boolean().optional(),
    assignedUserId: z.uuid().optional(),
    status: TaskStatus.optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), { message: 'nothing to change', path: ['title'] });
export type UpdateTaskBody = z.infer<typeof UpdateTaskBody>;
export type UpdateTaskInput = z.input<typeof UpdateTaskBody>;

/** `DELETE /v1/crm/tasks/:id`. */
export const TaskDeletedDto = z.strictObject({ deleted: z.literal(true) });
export type TaskDeletedDto = z.infer<typeof TaskDeletedDto>;
