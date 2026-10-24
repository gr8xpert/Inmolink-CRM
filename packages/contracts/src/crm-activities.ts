/**
 * CRM activity timeline (S10-04, PLAN §6 CRM `Activity`): what happened with a contact, a lead or a listing, newest
 * first — calls, e-mails, meetings and viewings a member logs, notes, and what other changes record (a lead received
 * or moved, a contact merged in, a listing's status). Internal to the agency: never shown in Client Mode.
 */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';

/** Activities a member logs by hand. */
export const MANUAL_ACTIVITY_TYPES = ['CALL', 'EMAIL', 'MEETING', 'VIEWING', 'OTHER'] as const;
/** Activities the system records (a note added, and changes other modules announce through the outbox). */
export const RECORDED_ACTIVITY_TYPES = [
  'NOTE_ADDED',
  'CONTACT_MERGED',
  'LEAD_CREATED',
  'LEAD_UPDATED',
  'LISTING_STATUS_CHANGED',
  'STAGE_CHANGED',
] as const;
export const ACTIVITY_TYPES = [...MANUAL_ACTIVITY_TYPES, ...RECORDED_ACTIVITY_TYPES] as const;
export const ActivityType = z.enum(ACTIVITY_TYPES);
export type ActivityType = z.infer<typeof ActivityType>;
export const ManualActivityType = z.enum(MANUAL_ACTIVITY_TYPES);

export const ACTIVITY_SUBJECTS = ['CONTACT', 'LEAD', 'LISTING'] as const;
export const ActivitySubject = z.enum(ACTIVITY_SUBJECTS);
export type ActivitySubject = z.infer<typeof ActivitySubject>;

/** Bounds of an activity. A logged one may be dated back up to `backdateDays` (the months kept online ahead). */
export const CRM_ACTIVITY_LIMITS = { bodyChars: 4_000, backdateDays: 30, typesPerFilter: 10 } as const;

export const ActivityDto = z.strictObject({
  id: z.uuid(),
  type: ActivityType,
  occurredAt: z.iso.datetime(),
  contactId: z.uuid().nullable(),
  leadId: z.uuid().nullable(),
  listingId: z.uuid().nullable(),
  /** The member who logged it; null when the system recorded it. */
  actorUserId: z.uuid().nullable(),
  body: z.string().nullable(),
  /** A recorded activity's detail: `{ status, assignedUserId }`, `{ from, to }` (a listing's status, a lead's stages: `{ fromStageId, toStageId, status }`), `{ mergedId }`, `{ noteId }`. */
  data: z.record(z.string(), z.unknown()),
});
export type ActivityDto = z.infer<typeof ActivityDto>;
export const ActivityPage = pageOf(ActivityDto);
export type ActivityPage = z.infer<typeof ActivityPage>;

/** Comma-separated types (`?type=CALL,EMAIL`), or repeated. */
const typeList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(ActivityType).min(1).max(CRM_ACTIVITY_LIMITS.typesPerFilter));

/**
 * `GET /v1/crm/activities`: the timeline, newest first, keyset (≤ 100 per page). `subject` + `subjectId` narrow it to
 * one contact, lead or listing (both or neither); without them, the agency's whole feed. `type` filters by type.
 */
export const ListActivitiesQuery = PageQuery.extend({
  subject: ActivitySubject.optional(),
  subjectId: z.uuid().optional(),
  type: typeList.optional(),
}).refine((q) => (q.subject === undefined) === (q.subjectId === undefined), {
  message: 'subject and subjectId go together',
  path: ['subjectId'],
});
export type ListActivitiesQuery = z.infer<typeof ListActivitiesQuery>;
export type ListActivitiesInput = z.input<typeof ListActivitiesQuery>;

/**
 * `POST /v1/crm/activities`: log a call, e-mail, meeting or viewing about a contact, a lead and/or a listing (at least
 * one). `occurredAt` defaults to now; it may be up to 30 days back, never ahead. Accepts an `Idempotency-Key` (24 h
 * replay of the same body; another body with the key is `IDEMPOTENCY_KEY_REUSED`).
 */
export const CreateActivityBody = z
  .strictObject({
    type: ManualActivityType,
    contactId: z.uuid().optional(),
    leadId: z.uuid().optional(),
    listingId: z.uuid().optional(),
    occurredAt: z.iso.datetime().optional(),
    body: z.string().trim().min(1).max(CRM_ACTIVITY_LIMITS.bodyChars).optional(),
  })
  .refine((b) => b.contactId !== undefined || b.leadId !== undefined || b.listingId !== undefined, {
    message: 'contactId, leadId or listingId is required',
    path: ['contactId'],
  });
export type CreateActivityBody = z.infer<typeof CreateActivityBody>;
export type CreateActivityInput = z.input<typeof CreateActivityBody>;
