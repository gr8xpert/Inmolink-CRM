import type { Tx } from '@inmolink/db';
import { calendarEventAttendees, calendarEvents, calendarFeeds, contacts } from '@inmolink/db/schema/crm';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, notInArray, or, type SQL, sql } from 'drizzle-orm';
import type { KeysetCursor } from '../../pagination';

/**
 * Calendar queries (S10-06). Lists are one keyset on `(starts_at, id)` ascending — a plain column checked to the
 * millisecond, so the cursor's row comparison is an index condition under RLS (the S10-02 rule). A member's calendar
 * reads `calendar_event_attendees` (its copy of `starts_at`), the agency's reads `calendar_events`.
 */

export const eventColumns = {
  id: calendarEvents.id,
  agencyId: calendarEvents.agencyId,
  type: calendarEvents.type,
  title: calendarEvents.title,
  description: calendarEvents.description,
  location: calendarEvents.location,
  startsAt: calendarEvents.startsAt,
  endsAt: calendarEvents.endsAt,
  status: calendarEvents.status,
  organizerUserId: calendarEvents.organizerUserId,
  listingId: calendarEvents.listingId,
  remindMinutes: calendarEvents.remindMinutes,
  remindAt: calendarEvents.remindAt,
  createdAt: calendarEvents.createdAt,
  version: calendarEvents.version,
};
export type EventRow = {
  id: string;
  agencyId: string;
  type: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  organizerUserId: string;
  listingId: string | null;
  remindMinutes: number | null;
  remindAt: Date | null;
  createdAt: Date;
  version: number;
};

export interface NewEvent {
  id: string;
  agencyId: string;
  type: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  organizerUserId: string;
  createdBy: string | null;
  listingId: string | null;
  remindMinutes: number | null;
  remindAt: Date | null;
  remindedAt: Date | null;
  idempotencyHash: string | null;
  requestHash: string | null;
}

export async function insertEvent(tx: Tx, row: NewEvent): Promise<EventRow> {
  const [created] = await tx.insert(calendarEvents).values(row).returning(eventColumns);
  if (!created) throw new Error('crm: calendar event insert returned no row');
  return created;
}

/** An event of the agency; `forUpdate` locks the row. */
export async function getEvent(
  tx: Tx,
  agencyId: string,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<EventRow | null> {
  const q = tx
    .select(eventColumns)
    .from(calendarEvents)
    .where(and(eq(calendarEvents.agencyId, agencyId), eq(calendarEvents.id, id)));
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

export async function eventByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ row: EventRow; requestHash: string | null } | null> {
  const [row] = await tx
    .select({ ...eventColumns, requestHash: calendarEvents.requestHash })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.agencyId, agencyId),
        eq(calendarEvents.idempotencyHash, hash),
        gt(calendarEvents.createdAt, since),
      ),
    );
  if (!row) return null;
  const { requestHash, ...rest } = row;
  return { row: rest, requestHash };
}

export interface EventPatch {
  type?: string;
  title?: string;
  description?: string | null;
  location?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  status?: string;
  cancelledAt?: Date | null;
  remindMinutes?: number | null;
  remindAt?: Date | null;
  remindedAt?: Date | null;
}

/** Updates under the caller's version (always a new version: attendee changes too); null when the version moved. */
export async function updateEvent(
  tx: Tx,
  agencyId: string,
  id: string,
  version: number,
  patch: EventPatch,
): Promise<EventRow | null> {
  const [row] = await tx
    .update(calendarEvents)
    .set({ ...patch, version: sql`${calendarEvents.version} + 1`, updatedAt: new Date() })
    .where(and(eq(calendarEvents.agencyId, agencyId), eq(calendarEvents.id, id), eq(calendarEvents.version, version)))
    .returning(eventColumns);
  return row ?? null;
}

// ---- attendees ------------------------------------------------------------------------------------------------------

export interface NewAttendee {
  id: string;
  agencyId: string;
  eventId: string;
  userId: string | null;
  contactId: string | null;
  startsAt: Date;
}

export async function insertAttendees(tx: Tx, rows: readonly NewAttendee[]): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(calendarEventAttendees)
    .values([...rows])
    .onConflictDoNothing();
}

/**
 * Removes the event's member attendees not in `keepUserIds` (the caller always keeps the organizer) and / or its contact
 * attendees not in `keepContactIds` (a list left undefined is not touched). One statement.
 */
export async function removeAttendees(
  tx: Tx,
  agencyId: string,
  eventId: string,
  keep: { userIds?: readonly string[]; contactIds?: readonly string[] },
): Promise<void> {
  const a = calendarEventAttendees;
  const gone = (column: typeof a.userId | typeof a.contactId, ids: readonly string[]) =>
    ids.length > 0 ? and(isNotNull(column), notInArray(column, [...ids])) : isNotNull(column);
  const kinds = [
    keep.userIds ? gone(a.userId, keep.userIds) : undefined,
    keep.contactIds ? gone(a.contactId, keep.contactIds) : undefined,
  ].filter((c): c is SQL => c !== undefined);
  if (kinds.length === 0) return;
  await tx
    .delete(a)
    .where(and(eq(a.agencyId, agencyId), eq(a.eventId, eventId), kinds.length === 1 ? kinds[0] : or(...kinds)));
}

/** The event moved: its attendees' copy of the start follows (`calendar_event_attendees_event_idx`). */
export async function moveAttendees(tx: Tx, agencyId: string, eventId: string, startsAt: Date): Promise<void> {
  await tx
    .update(calendarEventAttendees)
    .set({ startsAt })
    .where(and(eq(calendarEventAttendees.agencyId, agencyId), eq(calendarEventAttendees.eventId, eventId)));
}

export interface AttendeeRow {
  eventId: string;
  userId: string | null;
  contactId: string | null;
  contactName: string | null;
}

/**
 * The attendees of these events, contacts with their name (first and last; null when they have none). One statement
 * (`calendar_event_attendees_event_idx`, contacts by primary key).
 */
export async function attendeesOf(tx: Tx, agencyId: string, eventIds: readonly string[]): Promise<AttendeeRow[]> {
  if (eventIds.length === 0) return [];
  const rows = await tx
    .select({
      eventId: calendarEventAttendees.eventId,
      userId: calendarEventAttendees.userId,
      contactId: calendarEventAttendees.contactId,
      contactName: sql<string | null>`nullif(btrim(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})), '')`,
    })
    .from(calendarEventAttendees)
    .leftJoin(
      contacts,
      and(eq(contacts.agencyId, calendarEventAttendees.agencyId), eq(contacts.id, calendarEventAttendees.contactId)),
    )
    .where(and(eq(calendarEventAttendees.agencyId, agencyId), inArray(calendarEventAttendees.eventId, [...eventIds])))
    .orderBy(asc(calendarEventAttendees.createdAt), asc(calendarEventAttendees.id));
  return rows;
}

/** These contacts' names (null: no name), for the open (not merged away) contacts of the agency only. One statement. */
export async function openContacts(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: contacts.id,
      name: sql<string | null>`nullif(btrim(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})), '')`,
    })
    .from(contacts)
    .where(and(eq(contacts.agencyId, agencyId), inArray(contacts.id, [...ids]), isNull(contacts.deletedAt)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export interface EventRange {
  from: Date;
  to: Date;
  /** A member's calendar (the events they attend); omitted: the agency's. */
  userId?: string;
}

/** An event lasts at most 7 days (checked): one overlapping `from` started at most that long before it. */
export const MAX_EVENT_MS = 7 * 86_400_000;
const earliestStart = (from: Date) => new Date(from.getTime() - MAX_EVENT_MS);

/**
 * The events overlapping `[from, to)` — started before `to`, ending after `from` (so at most 7 days before it) — one
 * page, soonest first. A member's: `calendar_event_attendees_user_idx` (agency, user, starts_at, event) as a range +
 * keyset, then the events by primary key; the agency's: `calendar_events_agency_idx`.
 */
export async function listEvents(
  tx: Tx,
  agencyId: string,
  range: EventRange,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<EventRow[]> {
  if (range.userId) {
    const a = calendarEventAttendees;
    const conds: (SQL | undefined)[] = [
      eq(a.agencyId, agencyId),
      eq(a.userId, range.userId),
      gte(a.startsAt, earliestStart(range.from)),
      lt(a.startsAt, range.to),
      gt(calendarEvents.endsAt, range.from),
    ];
    if (page.cursor) {
      conds.push(
        sql`(${a.startsAt}, ${a.eventId}) > (${page.cursor.at.toISOString()}::timestamptz, ${page.cursor.id}::uuid)`,
      );
    }
    return tx
      .select(eventColumns)
      .from(a)
      .innerJoin(calendarEvents, and(eq(calendarEvents.agencyId, a.agencyId), eq(calendarEvents.id, a.eventId)))
      .where(and(...conds))
      .orderBy(asc(a.startsAt), asc(a.eventId))
      .limit(page.limit + 1);
  }
  const e = calendarEvents;
  const conds: (SQL | undefined)[] = [
    eq(e.agencyId, agencyId),
    gte(e.startsAt, earliestStart(range.from)),
    lt(e.startsAt, range.to),
    gt(e.endsAt, range.from),
  ];
  if (page.cursor) {
    conds.push(sql`(${e.startsAt}, ${e.id}) > (${page.cursor.at.toISOString()}::timestamptz, ${page.cursor.id}::uuid)`);
  }
  return tx
    .select(eventColumns)
    .from(e)
    .where(and(...conds))
    .orderBy(asc(e.startsAt), asc(e.id))
    .limit(page.limit + 1);
}

/** A purged listing leaves the agency's events (they stay, without the listing; a new version). */
export async function clearListing(tx: Tx, agencyId: string, listingId: string): Promise<number> {
  const rows = await tx
    .update(calendarEvents)
    .set({ listingId: null, version: sql`${calendarEvents.version} + 1`, updatedAt: new Date() })
    .where(and(eq(calendarEvents.agencyId, agencyId), eq(calendarEvents.listingId, listingId)))
    .returning({ id: calendarEvents.id });
  return rows.length;
}

// ---- reminders (worker, app_system) -------------------------------------------------------------------------------

export interface ClaimedEventReminder {
  eventId: string;
  agencyId: string;
  userId: string;
  remindMs: number;
}

/**
 * The reminder sweep's claim (system role, every agency): up to `limit` scheduled events whose `remind_at` came within
 * the last `graceMs`, at most `perAgency` of any one agency, oldest first — picked by a window over the partial index,
 * locked `for update skip locked` (a concurrent sweep takes others), marked `reminded_at` — and their member attendees,
 * one row each (the caller writes one outbox event per row in the same transaction). One statement.
 */
export async function claimDueReminders(
  tx: Tx,
  now: Date,
  graceMs: number,
  limit: number,
  perAgency: number,
): Promise<ClaimedEventReminder[]> {
  const since = new Date(now.getTime() - graceMs);
  const res = await tx.execute(sql`
    with candidates as (
      select id from (
        select id, remind_at, row_number() over (partition by agency_id order by remind_at, id) as n
          from ${calendarEvents}
         where status = 'SCHEDULED' and remind_at is not null and reminded_at is null
           and remind_at <= ${now} and remind_at > ${since}) ranked
       where n <= ${perAgency}
       order by remind_at, id
       limit ${limit}),
    due as (
      select e.id from ${calendarEvents} e join candidates c on c.id = e.id
       where e.status = 'SCHEDULED' and e.remind_at is not null and e.reminded_at is null
         for update of e skip locked),
    claimed as (
      update ${calendarEvents} e set reminded_at = ${now}
        from due where e.id = due.id
      returning e.id, e.agency_id, (extract(epoch from e.remind_at) * 1000)::bigint as remind_ms)
    select c.id, c.agency_id, c.remind_ms, a.user_id
      from claimed c
      join ${calendarEventAttendees} a on a.agency_id = c.agency_id and a.event_id = c.id and a.user_id is not null
     order by c.remind_ms, c.id, a.user_id`);
  return (res.rows as { id: string; agency_id: string; remind_ms: string | number; user_id: string }[]).map((r) => ({
    eventId: r.id,
    agencyId: r.agency_id,
    userId: r.user_id,
    remindMs: Number(r.remind_ms),
  }));
}

export interface ReminderEvent {
  type: string;
  title: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
}

/**
 * The send job's claim (system role, the agency named): marks this member attendee's reminder as sent for the
 * event's `remind_at` — only while the event is scheduled, its reminder was claimed by the sweep for exactly this remind
 * time, and not yet sent to this member for it. Null when there is nothing to send (cancelled, moved, removed, sent).
 */
export async function claimReminderSend(
  tx: Tx,
  p: { agencyId: string; eventId: string; userId: string; remindMs: number },
): Promise<ReminderEvent | null> {
  const res = await tx.execute(sql`
    update ${calendarEventAttendees} a set reminder_sent_for = e.remind_at
      from ${calendarEvents} e
     where a.agency_id = ${p.agencyId} and a.event_id = ${p.eventId} and a.user_id = ${p.userId}
       and e.agency_id = a.agency_id and e.id = a.event_id and e.status = 'SCHEDULED'
       and e.reminded_at is not null and e.remind_at is not null
       and (extract(epoch from e.remind_at) * 1000)::bigint = ${p.remindMs}
       and a.reminder_sent_for is distinct from e.remind_at
    returning e.type, e.title, e.location, e.starts_at, e.ends_at`);
  const r = res.rows[0] as
    | { type: string; title: string; location: string | null; starts_at: Date | string; ends_at: Date | string }
    | undefined;
  if (!r) return null;
  return {
    type: r.type,
    title: r.title,
    location: r.location,
    startsAt: new Date(r.starts_at),
    endsAt: new Date(r.ends_at),
  };
}

/** Gives a member's send claim back after a send known not to have gone out (only for the remind time claimed). */
export async function releaseReminderSend(
  tx: Tx,
  p: { agencyId: string; eventId: string; userId: string; remindMs: number },
): Promise<void> {
  await tx.execute(sql`
    update ${calendarEventAttendees} set reminder_sent_for = null
     where agency_id = ${p.agencyId} and event_id = ${p.eventId} and user_id = ${p.userId}
       and (extract(epoch from reminder_sent_for) * 1000)::bigint = ${p.remindMs}`);
}

// ---- ICS feeds ----------------------------------------------------------------------------------------------------

export interface FeedRow {
  tokenHint: string;
  createdAt: Date;
}

/** The member's live feed (no token hash: app_user cannot read it). */
export async function liveFeed(tx: Tx, agencyId: string, userId: string): Promise<FeedRow | null> {
  const [row] = await tx
    .select({ tokenHint: calendarFeeds.tokenHint, createdAt: calendarFeeds.createdAt })
    .from(calendarFeeds)
    .where(
      and(eq(calendarFeeds.agencyId, agencyId), eq(calendarFeeds.userId, userId), isNull(calendarFeeds.revokedAt)),
    );
  return row ?? null;
}

/** Revokes the member's live feed; answers its id, or null when there was none. */
export async function revokeFeed(tx: Tx, agencyId: string, userId: string, now: Date): Promise<string | null> {
  const rows = await tx
    .update(calendarFeeds)
    .set({ revokedAt: now })
    .where(and(eq(calendarFeeds.agencyId, agencyId), eq(calendarFeeds.userId, userId), isNull(calendarFeeds.revokedAt)))
    .returning({ id: calendarFeeds.id });
  return rows[0]?.id ?? null;
}

export async function insertFeed(
  tx: Tx,
  row: { id: string; agencyId: string; userId: string; tokenHash: string; tokenHint: string; createdAt: Date },
): Promise<FeedRow> {
  await tx.insert(calendarFeeds).values(row);
  return { tokenHint: row.tokenHint, createdAt: row.createdAt };
}

export interface FeedEventRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  version: number;
  updatedAt: Date;
  memberNames: string[];
  contactNames: string[];
}

/**
 * feed-api (`app_public`): the events of the live feed with this token hash, through the SECURITY DEFINER
 * `calendar_feed_by_token` (app_public reads no calendar, contact, member or user table itself): up to `max` upcoming
 * ones (`[now, to)`) and up to `max` recent ones (`[from, now)`), unordered. Null for an unknown, rotated or revoked
 * token or a member who lost access; else the events (possibly none). One statement.
 */
export async function feedEvents(
  tx: Tx,
  tokenHash: string,
  range: { from: Date; now: Date; to: Date },
  max: number,
): Promise<FeedEventRow[] | null> {
  const res = await tx.execute(sql`
    select event_id, type, title, description, location, starts_at, ends_at, status, version, updated_at,
           member_names, contact_names
      from calendar_feed_by_token(${tokenHash}, ${range.from.toISOString()}::timestamptz,
        ${range.now.toISOString()}::timestamptz, ${range.to.toISOString()}::timestamptz, ${max})`);
  const rows = res.rows as {
    event_id: string | null;
    type: string;
    title: string;
    description: string | null;
    location: string | null;
    starts_at: Date | string;
    ends_at: Date | string;
    status: string;
    version: number;
    updated_at: Date | string;
    member_names: string[] | null;
    contact_names: string[] | null;
  }[];
  if (rows.length === 0) return null;
  return rows
    .filter((r) => r.event_id !== null)
    .map((r) => ({
      id: r.event_id as string,
      type: r.type,
      title: r.title,
      description: r.description,
      location: r.location,
      startsAt: new Date(r.starts_at),
      endsAt: new Date(r.ends_at),
      status: r.status,
      version: Number(r.version),
      updatedAt: new Date(r.updated_at),
      memberNames: r.member_names ?? [],
      contactNames: r.contact_names ?? [],
    }));
}
