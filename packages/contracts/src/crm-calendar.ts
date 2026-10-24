/**
 * CRM calendar (S10-06, PLAN §7 M8): viewings, meetings and calls with member and contact attendees, an e-mail reminder
 * to the member attendees, and a per-member ICS feed (a secret URL Google Calendar / Outlook subscribe to). Internal to
 * the agency: nothing here is open in Client Mode.
 */
import { z } from 'zod';
import { Cursor } from './common';

export const CALENDAR_EVENT_TYPES = ['VIEWING', 'MEETING', 'CALL'] as const;
export const CalendarEventType = z.enum(CALENDAR_EVENT_TYPES);
export type CalendarEventType = z.infer<typeof CalendarEventType>;

export const CALENDAR_EVENT_STATUSES = ['SCHEDULED', 'CANCELLED'] as const;
export const CalendarEventStatus = z.enum(CALENDAR_EVENT_STATUSES);
export type CalendarEventStatus = z.infer<typeof CalendarEventStatus>;

export const CRM_CALENDAR_LIMITS = {
  titleChars: 200,
  descriptionChars: 4_000,
  locationChars: 300,
  /** Member attendees besides the organizer, and contact attendees, per event. */
  users: 20,
  contacts: 20,
  /** An event lasts at most this long. */
  maxDurationMs: 7 * 24 * 3_600_000,
  /** A reminder at most this many minutes (7 days) before the start. */
  maxRemindMinutes: 10_080,
  /** A list's date range (`from` → `to`) spans at most this many days. */
  rangeDays: 62,
} as const;

const TITLE_BAD = /[\p{Cc}\u2028\u2029]/u;
const TEXT_BAD = /(?![\n\r\t])\p{Cc}|[\u2028\u2029]/u;
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !TITLE_BAD.test(v), { message: 'no control characters' });
const eventText = z
  .string()
  .trim()
  .min(1)
  .max(CRM_CALENDAR_LIMITS.descriptionChars)
  .refine((v) => !TEXT_BAD.test(v), { message: 'no control characters' });
/** Years 2000 … 8999. */
const eventTime = z.iso.datetime().refine(
  (v) => {
    const t = new Date(v).getTime();
    return t >= Date.UTC(2000, 0, 1) && t < Date.UTC(9000, 0, 1);
  },
  { message: 'out of range' },
);
const remindMinutes = z.number().int().min(0).max(CRM_CALENDAR_LIMITS.maxRemindMinutes);
const userIds = z.array(z.uuid()).max(CRM_CALENDAR_LIMITS.users);
const contactIds = z.array(z.uuid()).max(CRM_CALENDAR_LIMITS.contacts);

export const CalendarAttendeeDto = z.strictObject({
  kind: z.enum(['USER', 'CONTACT']),
  /** The member's user id or the contact's id. */
  id: z.uuid(),
  /** The member's team name or the contact's name (null: a contact without a name). */
  name: z.string().nullable(),
});
export type CalendarAttendeeDto = z.infer<typeof CalendarAttendeeDto>;

export const CalendarEventDto = z.strictObject({
  id: z.uuid(),
  type: CalendarEventType,
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: CalendarEventStatus,
  organizerUserId: z.uuid(),
  listingId: z.uuid().nullable(),
  /** Minutes before the start the member attendees are reminded by e-mail; null: no reminder. */
  remindMinutes: z.number().int().nullable(),
  /** The organizer first, then members, then contacts. */
  attendees: z.array(CalendarAttendeeDto),
  createdAt: z.iso.datetime(),
  version: z.number().int(),
});
export type CalendarEventDto = z.infer<typeof CalendarEventDto>;
export const CalendarEventPage = z.object({ items: z.array(CalendarEventDto), nextCursor: Cursor.nullable() });
export type CalendarEventPage = z.infer<typeof CalendarEventPage>;

export const CalendarEventParams = z.strictObject({ id: z.uuid() });
export type CalendarEventParams = z.infer<typeof CalendarEventParams>;

/**
 * `GET /v1/crm/calendar/events`: the events overlapping `[from, to)` (≤ 62 days; one that began before `from` and is
 * still running is listed), soonest first, keyset (≤ 100 per
 * page). `attendee`: `me` (the default: the events I attend or organize), `any` (the agency's) or a member's id.
 * Cancelled events are listed too (`status`).
 */
export const ListCalendarEventsQuery = z
  .object({
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    from: eventTime,
    to: eventTime,
    attendee: z.union([z.literal('me'), z.literal('any'), z.uuid()]).default('me'),
  })
  .refine((q) => new Date(q.to).getTime() > new Date(q.from).getTime(), { message: 'to after from', path: ['to'] })
  .refine((q) => new Date(q.to).getTime() - new Date(q.from).getTime() <= CRM_CALENDAR_LIMITS.rangeDays * 86_400_000, {
    message: `at most ${CRM_CALENDAR_LIMITS.rangeDays} days`,
    path: ['to'],
  });
export type ListCalendarEventsQuery = z.infer<typeof ListCalendarEventsQuery>;
export type ListCalendarEventsInput = z.input<typeof ListCalendarEventsQuery>;

const within7Days = (startsAt: string, endsAt: string) => {
  const d = new Date(endsAt).getTime() - new Date(startsAt).getTime();
  return d > 0 && d <= CRM_CALENDAR_LIMITS.maxDurationMs;
};

/**
 * `POST /v1/crm/calendar/events`. The caller organizes it (and attends it); `userIds` are other members invited,
 * `contactIds` the agency's contacts taking part (they get no e-mail). `listingId`: a viewing's listing. A reminder
 * already past when set sends nothing. Accepts an `Idempotency-Key` (24 h replay of the same body; another body with the
 * key is `IDEMPOTENCY_KEY_REUSED`).
 */
export const CreateCalendarEventBody = z
  .strictObject({
    type: CalendarEventType,
    title: oneLine(CRM_CALENDAR_LIMITS.titleChars),
    description: eventText.optional(),
    location: oneLine(CRM_CALENDAR_LIMITS.locationChars).optional(),
    startsAt: eventTime,
    endsAt: eventTime,
    remindMinutes: remindMinutes.nullable().default(30),
    userIds: userIds.default([]),
    contactIds: contactIds.default([]),
    listingId: z.uuid().optional(),
  })
  .refine((v) => within7Days(v.startsAt, v.endsAt), {
    message: 'ends after it starts, within 7 days',
    path: ['endsAt'],
  });
export type CreateCalendarEventBody = z.infer<typeof CreateCalendarEventBody>;
export type CreateCalendarEventInput = z.input<typeof CreateCalendarEventBody>;

/**
 * `PATCH /v1/crm/calendar/events/:id` (optimistic `version`). `userIds` / `contactIds` replace the attendee lists (the
 * organizer always attends). `status: CANCELLED` cancels (kept, shown as cancelled in subscribed calendars);
 * `SCHEDULED` restores it. A new time or reminder re-arms the reminder. `null` clears description, location, reminder.
 */
export const UpdateCalendarEventBody = z
  .strictObject({
    version: z.number().int().min(1),
    type: CalendarEventType.optional(),
    title: oneLine(CRM_CALENDAR_LIMITS.titleChars).optional(),
    description: eventText.nullable().optional(),
    location: oneLine(CRM_CALENDAR_LIMITS.locationChars).nullable().optional(),
    startsAt: eventTime.optional(),
    endsAt: eventTime.optional(),
    remindMinutes: remindMinutes.nullable().optional(),
    userIds: userIds.optional(),
    contactIds: contactIds.optional(),
    status: CalendarEventStatus.optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), { message: 'nothing to change', path: ['title'] })
  .refine((v) => (v.startsAt === undefined) === (v.endsAt === undefined), {
    message: 'startsAt and endsAt change together',
    path: ['endsAt'],
  })
  .refine((v) => v.startsAt === undefined || v.endsAt === undefined || within7Days(v.startsAt, v.endsAt), {
    message: 'ends after it starts, within 7 days',
    path: ['endsAt'],
  });
export type UpdateCalendarEventBody = z.infer<typeof UpdateCalendarEventBody>;
export type UpdateCalendarEventInput = z.input<typeof UpdateCalendarEventBody>;

// ---- the member's ICS feed ------------------------------------------------------------------------------------------

/** A calendar feed token: 32 random bytes, base64url. */
export const CalendarFeedToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `GET /v2/calendars/{token}/calendar.ics` (feed-api). */
export const CalendarFeedParams = z.object({ token: CalendarFeedToken });
export type CalendarFeedParams = z.infer<typeof CalendarFeedParams>;

/** The caller's ICS feed as the dashboard shows it: never the token, only its last characters. */
export const CalendarFeedDto = z.strictObject({
  enabled: z.boolean(),
  tokenHint: z.string().nullable(),
  createdAt: z.iso.datetime().nullable(),
});
export type CalendarFeedDto = z.infer<typeof CalendarFeedDto>;

/** `POST /v1/crm/calendar/feed`: a new feed URL (the previous one stops working). The token is shown this once. */
export const CalendarFeedSecretDto = z.strictObject({
  feed: CalendarFeedDto,
  token: CalendarFeedToken,
  /** The feed's path on the website API host (`FEED_API_PUBLIC_URL`). */
  path: z.string(),
});
export type CalendarFeedSecretDto = z.infer<typeof CalendarFeedSecretDto>;
