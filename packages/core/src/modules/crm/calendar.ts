import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import {
  AppError,
  type CalendarAttendeeDto,
  type CalendarEventDto,
  type CalendarEventPage,
  type CalendarFeedDto,
  type CalendarFeedSecretDto,
  type CreateCalendarEventBody,
  type ListCalendarEventsQuery,
  type UpdateCalendarEventBody,
} from '@inmolink/contracts';
import { withPublicRead, withTenant } from '@inmolink/db';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { hmacSha256, hmacSha256Candidates, newToken } from '@inmolink/platform/crypto';
import { etagFor } from '@inmolink/platform/http';
import { newId } from '@inmolink/platform/ids';
import { type Ctx, userIdOf } from '../../context';
import { advisoryLock, idempotencyOf, keyReusedOn, replayOf } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as compliance from '../compliance';
import * as identity from '../identity';
import { auditImpersonatedRead } from './audit';
import { renderEventReminder } from './calendar-emails';
import { type IcsEvent, renderIcs } from './calendar-ics';
import * as repo from './calendar-repo';
import { crmEvents } from './events';
import { linkedListing } from './listing-ref';
import { assertCan, canManageEvent } from './policy';
import { sendReminder, sweepReminders } from './reminders';

/**
 * Calendar (S10-06, PLAN §7 M8): viewings, meetings and calls with member and contact attendees, an e-mail reminder to
 * the member attendees, and each member's ICS feed (a secret URL Google Calendar / Outlook subscribe to).
 *
 * - **Who sees what.** Every member of the agency sees its events (R1, like tasks); "my calendar" and the ICS feed are
 *   the events the member attends (the organizer always attends). A contact attendee is the agency's client: the feed
 *   shows their name only (no e-mail, no phone), and contacts never get mail from the calendar.
 * - **Reminders** (the S10-05 design, per member attendee): `crm.sweepEventReminders` (every minute) claims the
 *   scheduled events whose `remind_at` came — at most `REMINDER_SWEEP.perAgency` per agency per batch, `for update skip
 *   locked` — sets `reminded_at` and writes one `crm.calendarEvent.reminderDue` event per member attendee in that
 *   transaction; each becomes one `crm.sendEventReminder` job that claims the attendee's `reminder_sent_for` before it
 *   sends (Resend idempotency key: event + remind time + member). At most once per member and remind time; the claim is
 *   given back only after a failure known to precede the send. A cancelled event, a moved start or a changed offset stops
 *   a reminder on its way (the claim's conditions); a new remind time re-arms it; a remind time already past when set
 *   sends nothing; a reminder more than `EVENT_REMINDER_GRACE_MS` late is skipped. Members added after the sweep claimed a
 *   remind time are not reminded for it.
 * - **ICS feed.** One live token per member (32 random bytes, stored as its keyed hash): rotating replaces it, revoking
 *   stops the URL at once; so does losing access (deactivated, moved out of the CRM roles, login disabled, agency
 *   suspended). feed-api serves it through one SECURITY DEFINER statement (`calendar_feed_by_token`): the member's
 *   events from `FEED_PAST_DAYS` ago to `FEED_FUTURE_DAYS` ahead, at most `FEED_MAX_EVENTS` and ≤ 150 KB gzip — upcoming
 *   ones kept first —, cancelled ones as `STATUS:CANCELLED`, descriptions cut to `FEED_TEXT_CHARS`; private to the
 *   client for `CALENDAR_FEED_MAX_AGE_S` (a change shows at the next poll; never shared caches, so a revoked URL stops
 *   at once). A contact merge re-points attendees without a new event version: the names line changes, `SEQUENCE`
 *   does not (calendar apps take the new text at their next refresh).
 * - **Who changes an event.** Its organizer or an agency admin: edits, cancelling and attendee changes.
 */

/** How long after its remind time an event can still be reminded (a longer worker outage skips it). */
export const EVENT_REMINDER_GRACE_MS = 2 * 3_600_000;

export const FEED_PAST_DAYS = 30;
export const FEED_FUTURE_DAYS = 365;
export const FEED_MAX_EVENTS = 1_000;
/** `Cache-Control: private, max-age` of the feed (≤ 15 min: a change reaches subscribers within that, plus their poll). */
export const CALENDAR_FEED_MAX_AGE_S = 300;
/** The refresh hint written in the feed (Outlook honours it; Google polls on its own schedule). */
export const FEED_REFRESH_MINUTES = 15;

// ---- DTOs -----------------------------------------------------------------------------------------------------------

interface AttendeeSet {
  userIds: string[];
  contacts: Map<string, string | null>;
}

function attendeeSets(rows: readonly repo.AttendeeRow[]): Map<string, AttendeeSet> {
  const out = new Map<string, AttendeeSet>();
  for (const r of rows) {
    let set = out.get(r.eventId);
    if (!set) {
      set = { userIds: [], contacts: new Map() };
      out.set(r.eventId, set);
    }
    if (r.userId) set.userIds.push(r.userId);
    // a merge can leave two rows for one contact: shown once
    else if (r.contactId && !set.contacts.has(r.contactId)) set.contacts.set(r.contactId, r.contactName);
  }
  return out;
}

function toEventDto(row: repo.EventRow, set: AttendeeSet | undefined, names: Map<string, string>): CalendarEventDto {
  const others = (set?.userIds ?? []).filter((u) => u !== row.organizerUserId);
  const attendees: CalendarAttendeeDto[] = [
    { kind: 'USER', id: row.organizerUserId, name: names.get(row.organizerUserId) ?? null },
    ...others.map((id) => ({ kind: 'USER' as const, id, name: names.get(id) ?? null })),
    ...[...(set?.contacts ?? new Map<string, string | null>())].map(([id, name]) => ({
      kind: 'CONTACT' as const,
      id,
      name,
    })),
  ];
  return {
    id: row.id,
    type: row.type as CalendarEventDto['type'],
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status as CalendarEventDto['status'],
    organizerUserId: row.organizerUserId,
    listingId: row.listingId,
    remindMinutes: row.remindMinutes,
    attendees,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** The DTOs of these events: their attendees (one statement) and the members' names (one statement). */
async function toDtos(ctx: Ctx, rows: readonly repo.EventRow[]): Promise<CalendarEventDto[]> {
  const sets = attendeeSets(
    await repo.attendeesOf(
      ctx.tx,
      ctx.tenant.agencyId,
      rows.map((r) => r.id),
    ),
  );
  const userIds = new Set<string>();
  for (const r of rows) userIds.add(r.organizerUserId);
  for (const s of sets.values()) for (const u of s.userIds) userIds.add(u);
  const names = await identity.memberNames(ctx, [...userIds]);
  return rows.map((r) => toEventDto(r, sets.get(r.id), names));
}

// ---- checks ---------------------------------------------------------------------------------------------------------

/** Every invited member must be an active member who works clients (one statement for all of them). */
async function assertMembers(ctx: Ctx, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const active = await identity.activeClientMembersAmong(ctx.tx, ctx.tenant.agencyId, userIds);
  if (userIds.some((u) => !active.has(u))) {
    throw new AppError('VALIDATION_FAILED', { field: 'userIds', reason: 'not_a_member' });
  }
}

/** Every contact must be an open contact of the agency; their names (one statement). */
async function openContacts(ctx: Ctx, contactIds: readonly string[]): Promise<Map<string, string | null>> {
  const open = await repo.openContacts(ctx.tx, ctx.tenant.agencyId, contactIds);
  if (contactIds.some((c) => !open.has(c))) throw new AppError('CONTACT_NOT_FOUND');
  return open;
}

const unique = (ids: readonly string[]) => [...new Set(ids)];
const remindAtOf = (startsAt: Date, minutes: number | null) =>
  minutes === null ? null : new Date(startsAt.getTime() - minutes * 60_000);
/** A remind time already past is never reminded: it is created "reminded". */
const armedAt = (remindAt: Date | null, now: Date): Date | null =>
  remindAt && remindAt.getTime() <= now.getTime() ? now : null;

// ---- events ---------------------------------------------------------------------------------------------------------

/**
 * `GET /v1/crm/calendar/events`: the events overlapping `[from, to)`, soonest first, keyset (≤ 100 per page). Three
 * statements: the page, its attendees, the members' names.
 */
export async function listCalendarEvents(ctx: Ctx, query: ListCalendarEventsQuery): Promise<CalendarEventPage> {
  assertCan(ctx, 'crm.calendar.read');
  const cursor = decodeCursor(query.cursor);
  const range: repo.EventRange = { from: new Date(query.from), to: new Date(query.to) };
  if (query.attendee === 'me') {
    const me = userIdOf(ctx);
    if (!me) throw new AppError('VALIDATION_FAILED', { field: 'attendee' });
    range.userId = me;
  } else if (query.attendee !== 'any') range.userId = query.attendee;
  const rows = await repo.listEvents(
    ctx.tx,
    ctx.tenant.agencyId,
    range,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  const page = rows.slice(0, query.limit);
  const dtos = await toDtos(ctx, page);
  const byId = new Map(dtos.map((d) => [d.id, d]));
  await auditImpersonatedRead(ctx, 'calendar', { count: page.length });
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.startsAt, id: r.id }),
    (r) => byId.get(r.id) as CalendarEventDto,
  );
}

export async function getCalendarEvent(ctx: Ctx, id: string): Promise<CalendarEventDto> {
  assertCan(ctx, 'crm.calendar.read');
  const row = await repo.getEvent(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('CALENDAR_EVENT_NOT_FOUND');
  const [dto] = await toDtos(ctx, [row]);
  await auditImpersonatedRead(ctx, 'calendar', { target: { type: 'calendarEvent', id } });
  return dto as CalendarEventDto;
}

/**
 * `POST /v1/crm/calendar/events`: the caller organizes (and attends) it. With an `Idempotency-Key`, a retry by the same
 * member within 24 h with the same body answers the first event; another body is `IDEMPOTENCY_KEY_REUSED`.
 */
export async function createCalendarEvent(
  ctx: Ctx,
  input: CreateCalendarEventBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ event: CalendarEventDto; replayed: boolean }> {
  assertCan(ctx, 'crm.calendar.write');
  const me = userIdOf(ctx);
  if (!me) throw new AppError('FORBIDDEN');
  const agencyId = ctx.tenant.agencyId;
  const now = new Date();
  const idempotency = idempotencyOf('crm.calendar', me, opts.idempotencyKey, input);
  const prior = await replayOf(
    ctx.tx,
    idempotency,
    (since, key) => repo.eventByIdempotency(ctx.tx, agencyId, key.hash, since),
    { lock: true, now },
  );
  if (prior) {
    const [dto] = await toDtos(ctx, [prior.row]);
    return { event: dto as CalendarEventDto, replayed: true };
  }

  const userIds = unique(input.userIds).filter((u) => u !== me);
  const contactIds = unique(input.contactIds);
  await assertMembers(ctx, userIds);
  const contactNames = await openContacts(ctx, contactIds);
  if (input.listingId) {
    await linkedListing(ctx.tx, agencyId, input.listingId, { ownOnly: true });
  }
  const startsAt = new Date(input.startsAt);
  const remindAt = remindAtOf(startsAt, input.remindMinutes);
  const row = await repo
    .insertEvent(ctx.tx, {
      id: newId(),
      agencyId,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt,
      endsAt: new Date(input.endsAt),
      organizerUserId: me,
      createdBy: me,
      listingId: input.listingId ?? null,
      remindMinutes: input.remindMinutes,
      remindAt,
      remindedAt: armedAt(remindAt, now),
      idempotencyHash: idempotency?.hash ?? null,
      requestHash: idempotency?.requestHash ?? null,
    })
    .catch(keyReusedOn('calendar_events_idempotency_uq'));
  await repo.insertAttendees(ctx.tx, [
    ...[me, ...userIds].map((userId) => ({
      id: newId(),
      agencyId,
      eventId: row.id,
      userId,
      contactId: null,
      startsAt,
    })),
    ...contactIds.map((contactId) => ({ id: newId(), agencyId, eventId: row.id, userId: null, contactId, startsAt })),
  ]);
  const names = await identity.memberNames(ctx, [me, ...userIds]);
  const set: AttendeeSet = {
    userIds: [me, ...userIds],
    contacts: new Map(contactIds.map((c) => [c, contactNames.get(c) ?? null])),
  };
  return { event: toEventDto(row, set, names), replayed: false };
}

/**
 * `PATCH /v1/crm/calendar/events/:id` (optimistic `version`): any change, attendees included, is a new version (the
 * feed's `SEQUENCE`). A new start or reminder offset, or a cancelled event scheduled again, re-arms the reminder.
 * At most nine statements.
 */
export async function updateCalendarEvent(
  ctx: Ctx,
  id: string,
  input: UpdateCalendarEventBody,
): Promise<CalendarEventDto> {
  assertCan(ctx, 'crm.calendar.write');
  const agencyId = ctx.tenant.agencyId;
  const current = await repo.getEvent(ctx.tx, agencyId, id, { forUpdate: true });
  if (!current) throw new AppError('CALENDAR_EVENT_NOT_FOUND');
  if (!canManageEvent(ctx, current.organizerUserId)) throw new AppError('FORBIDDEN');
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const now = new Date();
  const before = attendeeSets(await repo.attendeesOf(ctx.tx, agencyId, [id])).get(id) ?? {
    userIds: [],
    contacts: new Map<string, string | null>(),
  };

  const patch: repo.EventPatch = {};
  if (input.type !== undefined && input.type !== current.type) patch.type = input.type;
  if (input.title !== undefined && input.title !== current.title) patch.title = input.title;
  if (input.description !== undefined && input.description !== current.description)
    patch.description = input.description;
  if (input.location !== undefined && input.location !== current.location) patch.location = input.location;
  const startsAt = input.startsAt ? new Date(input.startsAt) : current.startsAt;
  const endsAt = input.endsAt ? new Date(input.endsAt) : current.endsAt;
  const moved = startsAt.getTime() !== current.startsAt.getTime();
  if (moved) patch.startsAt = startsAt;
  if (endsAt.getTime() !== current.endsAt.getTime()) patch.endsAt = endsAt;
  const minutes = input.remindMinutes === undefined ? current.remindMinutes : input.remindMinutes;
  if (minutes !== current.remindMinutes) patch.remindMinutes = minutes;
  const remindAt = remindAtOf(startsAt, minutes);
  const status = input.status ?? current.status;
  const restored = status === 'SCHEDULED' && current.status === 'CANCELLED';
  if (status !== current.status) {
    patch.status = status;
    patch.cancelledAt = status === 'CANCELLED' ? now : null;
  }
  if ((remindAt?.getTime() ?? null) !== (current.remindAt?.getTime() ?? null) || restored) {
    patch.remindAt = remindAt;
    patch.remindedAt = armedAt(remindAt, now);
  }

  // attendees: the organizer always attends; lists given replace the current ones
  const organizer = current.organizerUserId;
  const userIds = input.userIds ? unique([organizer, ...input.userIds]) : null;
  const contactIds = input.contactIds ? unique(input.contactIds) : null;
  const addedUsers = userIds ? userIds.filter((u) => !before.userIds.includes(u)) : [];
  const removedUsers = userIds ? before.userIds.filter((u) => !userIds.includes(u)) : [];
  const addedContacts = contactIds ? contactIds.filter((c) => !before.contacts.has(c)) : [];
  const removedContacts = contactIds ? [...before.contacts.keys()].filter((c) => !contactIds.includes(c)) : [];
  await assertMembers(ctx, addedUsers);
  const addedNames = await openContacts(ctx, addedContacts);
  const attendeesChanged = addedUsers.length + removedUsers.length + addedContacts.length + removedContacts.length > 0;

  if (Object.keys(patch).length === 0 && !attendeesChanged) {
    const names = await identity.memberNames(ctx, before.userIds.length > 0 ? before.userIds : [organizer]);
    return toEventDto(current, before, names);
  }
  const updated = await repo.updateEvent(ctx.tx, agencyId, id, input.version, patch);
  if (!updated) throw new AppError('VERSION_CONFLICT');
  if (removedUsers.length > 0 || removedContacts.length > 0) {
    await repo.removeAttendees(ctx.tx, agencyId, id, {
      ...(removedUsers.length > 0 && userIds ? { userIds } : {}),
      ...(removedContacts.length > 0 && contactIds ? { contactIds } : {}),
    });
  }
  if (moved) await repo.moveAttendees(ctx.tx, agencyId, id, startsAt);
  await repo.insertAttendees(ctx.tx, [
    ...addedUsers.map((userId) => ({ id: newId(), agencyId, eventId: id, userId, contactId: null, startsAt })),
    ...addedContacts.map((contactId) => ({ id: newId(), agencyId, eventId: id, userId: null, contactId, startsAt })),
  ]);
  const after: AttendeeSet = {
    userIds: userIds ?? before.userIds,
    contacts: contactIds
      ? new Map(contactIds.map((c) => [c, before.contacts.get(c) ?? addedNames.get(c) ?? null]))
      : before.contacts,
  };
  const names = await identity.memberNames(ctx, unique([organizer, ...after.userIds]));
  return toEventDto(updated, after, names);
}

// ---- reminders (worker) ---------------------------------------------------------------------------------------------

/**
 * `crm.sweepEventReminders`: claims the events whose reminder came (within `EVENT_REMINDER_GRACE_MS`), up to
 * `REMINDER_SWEEP.batch × maxBatches` per pass, at most `perAgency` of one agency per batch. Each batch is one
 * system transaction: the claim and one outbox event per member attendee commit together.
 */
export async function sweepEventReminders(
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<{ claimed: repo.ClaimedEventReminder[] }> {
  const claimed = await sweepReminders({
    job: 'crm.sweepEventReminders',
    ...opts,
    claim: (tx, now, limits) =>
      repo.claimDueReminders(tx, now, EVENT_REMINDER_GRACE_MS, limits.batch, limits.perAgency),
    events: (r) =>
      crmEvents.eventReminderDue({ agencyId: r.agencyId, eventId: r.eventId, userId: r.userId, remindMs: r.remindMs }),
  });
  return { claimed };
}

/**
 * `crm.sendEventReminder`: one member's reminder e-mail of a claimed event (the flow is `sendReminder`).
 */
export function sendEventReminder(p: repo.ClaimedEventReminder): Promise<{ sent: boolean }> {
  return sendReminder({
    job: 'crm.sendEventReminder',
    agencyId: p.agencyId,
    claim: (tx) => repo.claimReminderSend(tx, p),
    recipientUserId: () => p.userId,
    render: (event, to, timeZone) =>
      renderEventReminder({
        to: to.email,
        name: to.name,
        locale: to.locale,
        type: event.type,
        title: event.title,
        location: event.location,
        startsAt: event.startsAt,
        timeZone,
      }),
    idempotencyKey: `event-reminder:${p.eventId}:${p.remindMs}:${p.userId}`,
    release: (tx) => repo.releaseReminderSend(tx, p),
  });
}

/** A purged listing leaves the agency's events (they stay, without the listing). */
export async function forgetListingEvents(p: { agencyId: string; listingId: string }): Promise<{ rows: number }> {
  const rows = await withTenant({ agencyId: p.agencyId }, (tx) => repo.clearListing(tx, p.agencyId, p.listingId));
  return { rows };
}

// ---- the member's ICS feed ------------------------------------------------------------------------------------------

const TOKEN_PURPOSE = 'crm.calendar-feed-token';
let tokenKey: Buffer | undefined;

/** Boot (api and feed-api): the key feed tokens are hashed with (`HMAC_KEY`, purpose-separated). */
export function configureCalendarFeeds(options: { tokenKey: string }): void {
  if (!options.tokenKey) throw new Error('crm: calendar feed tokenKey is required');
  tokenKey = Buffer.from(options.tokenKey);
}

function feedTokenHash(token: string): string {
  if (!tokenKey) throw new Error('crm: configureCalendarFeeds() was not called');
  return hmacSha256(tokenKey, TOKEN_PURPOSE, token);
}

/** Where a member's feed is served, relative to the website API host. */
export const calendarFeedPath = (token: string) => `/v2/calendars/${token}/calendar.ics`;

const toFeedDto = (row: repo.FeedRow | null): CalendarFeedDto => ({
  enabled: row !== null,
  tokenHint: row?.tokenHint ?? null,
  createdAt: row?.createdAt.toISOString() ?? null,
});

function feedMember(ctx: Ctx): string {
  assertCan(ctx, 'crm.calendar.feed');
  const me = userIdOf(ctx);
  if (!me) throw new AppError('FORBIDDEN');
  return me;
}

/** `GET /v1/crm/calendar/feed`: whether the caller's feed is on, and the token's last characters. */
export async function getCalendarFeed(ctx: Ctx): Promise<CalendarFeedDto> {
  const me = feedMember(ctx);
  return toFeedDto(await repo.liveFeed(ctx.tx, ctx.tenant.agencyId, me));
}

/**
 * `POST /v1/crm/calendar/feed`: a new feed URL for the caller (the previous one stops at once). The token is in the
 * answer only. Concurrent rotations of one member are serialized (advisory lock).
 */
export async function rotateCalendarFeed(ctx: Ctx): Promise<CalendarFeedSecretDto> {
  const me = feedMember(ctx);
  const agencyId = ctx.tenant.agencyId;
  await advisoryLock(ctx.tx, `calendar-feed:${agencyId}:${me}`);
  const now = new Date();
  const previousId = await repo.revokeFeed(ctx.tx, agencyId, me, now);
  const token = newToken(32);
  const id = newId();
  const row = await repo.insertFeed(ctx.tx, {
    id,
    agencyId,
    userId: me,
    tokenHash: feedTokenHash(token),
    tokenHint: token.slice(-4),
    createdAt: now,
  });
  // A credential: who issued it, never the token (the hint is not recorded either).
  await compliance.audit(
    ctx,
    previousId ? 'crm.calendarFeed.rotated' : 'crm.calendarFeed.issued',
    { type: 'calendarFeed', id },
    previousId ? { previousId } : {},
  );
  return { feed: toFeedDto(row), token, path: calendarFeedPath(token) };
}

/** `DELETE /v1/crm/calendar/feed`: the caller's feed URL stops working at once. */
export async function revokeCalendarFeed(ctx: Ctx): Promise<CalendarFeedDto> {
  const me = feedMember(ctx);
  const revokedId = await repo.revokeFeed(ctx.tx, ctx.tenant.agencyId, me, new Date());
  if (revokedId) await compliance.audit(ctx, 'crm.calendarFeed.revoked', { type: 'calendarFeed', id: revokedId });
  return toFeedDto(null);
}

export interface CalendarFeedFile {
  /** `text/calendar; charset=utf-8`, CRLF lines (RFC 5545). */
  body: string;
  /** The same, gzip-compressed (≤ `FEED_MAX_GZIP_BYTES`). */
  gzip: Buffer;
  /**
   * `renderCalendarFeed`: a strong ETag (the body's hash). `calendarFeed`: the feed's weak ETag (`calendarFeedTag`),
   * so a later If-None-Match is answered from the fingerprint alone.
   */
  etag: string;
}

/** Changes every feed's ETag when what a feed renders changes shape (a release that changes the ICS output). */
const FEED_TAG_FORMAT = 1;
/**
 * The ETag also changes every hour: attendees' names (a member or contact renamed, a contact merged) and which events a
 * capped feed keeps (upcoming ones first, relative to now) change the document without changing any event's version —
 * they reach subscribers within the hour (plus `CALENDAR_FEED_MAX_AGE_S` and their poll).
 */
export const FEED_TAG_BUCKET_MS = 3_600_000;

const gzipAsync = promisify(gzip);

/** Characters of an event's description, and of its attendees line, written in the feed (the dashboard has the rest). */
export const FEED_TEXT_CHARS = 300;
/** The feed's compressed size cap (the feed-api 150 KB budget): the farthest events are dropped to stay under it. */
export const FEED_MAX_GZIP_BYTES = 150 * 1024;

/** A placeholder no name holds (names are one-line text): where the attendees' names go in the translated line. */
const NAMES_SLOT = '<<names>>';

const clip = (text: string, max: number) => {
  // at most `max` UTF-16 units is at most `max` characters: no need to split it (S11-F7)
  if (text.length <= max) return text;
  // walk code points only as far as needed (no array of every character)
  let end = 0;
  let count = 0;
  let cut = 0;
  while (end < text.length) {
    if (count === max - 1) cut = end;
    if (count === max) return `${text.slice(0, cut)}…`;
    end += (text.codePointAt(end) as number) > 0xffff ? 2 : 1;
    count += 1;
  }
  return text;
};

/**
 * The events a feed keeps, in the order it gives them up: upcoming ones soonest first, then recent ones latest first —
 * so a cap never drops an upcoming event before a past one.
 */
export function feedPriority(rows: readonly repo.FeedEventRow[], now: Date, max: number): repo.FeedEventRow[] {
  const upcoming = rows.filter((r) => r.startsAt >= now).sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
  const past = rows.filter((r) => r.startsAt < now).sort((x, y) => y.startsAt.getTime() - x.startsAt.getTime());
  return [...upcoming, ...past].slice(0, max);
}

/**
 * Renders a feed's events (pure but for gzip, which runs off the event loop): descriptions and the attendees line cut
 * to `FEED_TEXT_CHARS`, events in time order; when the compressed document passes `FEED_MAX_GZIP_BYTES`, the
 * lowest-priority events (`feedPriority`) are dropped until it fits.
 */
export async function renderCalendarFeed(
  rows: readonly repo.FeedEventRow[],
  opts: { locale: string; now: Date; etag?: string },
): Promise<CalendarFeedFile> {
  // the caller's ETag when it has one (`calendarFeed`: the fingerprint's), else the body's hash
  const tagOf = (text: string) => opts.etag ?? etagFor(text);
  const locale = isUiLocale(opts.locale) ? opts.locale : DEFAULT_UI_LOCALE;
  const t = translator(locale, 'calendar');
  const kept = feedPriority(rows, opts.now, FEED_MAX_EVENTS);
  // the attendees line formatted once, filled per event (S11-F7: a message format per event adds up at 1,000)
  const [withBefore = '', withAfter = ''] = t('ics.with', { names: NAMES_SLOT }).split(NAMES_SLOT);
  const withLine = (names: string) => `${withBefore}${names}${withAfter}`;
  const categories = new Map<string, string>();
  const categoryOf = (type: string) => {
    let name = categories.get(type);
    if (name === undefined) {
      name = t(`types.${type as 'VIEWING' | 'MEETING' | 'CALL'}`);
      categories.set(type, name);
    }
    return name;
  };
  const render = (keep: readonly repo.FeedEventRow[]) => {
    const events: IcsEvent[] = [...keep]
      .sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime() || (x.id < y.id ? -1 : 1))
      .map((r) => {
        const people = [...r.memberNames, ...r.contactNames];
        return {
          id: r.id,
          title: r.title,
          description: r.description ? clip(r.description, FEED_TEXT_CHARS) : null,
          location: r.location,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          status: r.status,
          version: r.version,
          updatedAt: r.updatedAt,
          category: categoryOf(r.type),
          notes: people.length > 0 ? [clip(withLine(people.join(', ')), FEED_TEXT_CHARS)] : [],
        };
      });
    return renderIcs({ name: t('ics.name'), refreshMinutes: FEED_REFRESH_MINUTES, events });
  };
  const body = render(kept);
  const zipped = await gzipAsync(Buffer.from(body, 'utf8'));
  // the common case: one render, one gzip
  if (zipped.byteLength <= FEED_MAX_GZIP_BYTES || kept.length === 0) return { body, gzip: zipped, etag: tagOf(body) };
  // over the cap: one cut from the measured ratio, with a 15 % margin (the events dropped are similar to those kept)
  let n = Math.floor((kept.length * FEED_MAX_GZIP_BYTES * 0.85) / zipped.byteLength);
  for (;;) {
    const cutBody = render(kept.slice(0, n));
    const cutZipped = await gzipAsync(Buffer.from(cutBody, 'utf8'));
    if (cutZipped.byteLength <= FEED_MAX_GZIP_BYTES || n === 0) {
      return { body: cutBody, gzip: cutZipped, etag: tagOf(cutBody) };
    }
    // a margin miss (rare): cut again by the new ratio
    n = Math.floor((n * FEED_MAX_GZIP_BYTES * 0.85) / cutZipped.byteLength);
  }
}

function feedRange(now: Date) {
  return {
    from: new Date(now.getTime() - FEED_PAST_DAYS * 86_400_000),
    now,
    to: new Date(now.getTime() + FEED_FUTURE_DAYS * 86_400_000),
  };
}

const feedLocale = (locale: string | undefined) => (locale && isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

/** The weak ETag of a feed: its events' fingerprint, the locale, the hour and the format (opaque, ≤ 40 characters). */
function feedTag(f: repo.FeedFingerprint, locale: string, now: Date): string {
  const parts = [FEED_TAG_FORMAT, locale, Math.floor(now.getTime() / FEED_TAG_BUCKET_MS)];
  parts.push(f.events, f.versions.toString(), f.ids.toString(), f.updatedMs);
  return `W/"${createHash('sha256').update(parts.join(':')).digest('base64url').slice(0, 27)}"`;
}

/** The token's candidate hashes, current key first (inside the rotation window, the previous key's too). */
function tokenHashes(token: string): string[] {
  if (!tokenKey) throw new Error('crm: configureCalendarFeeds() was not called');
  return [...hmacSha256Candidates(tokenKey, TOKEN_PURPOSE, token)];
}

/**
 * feed-api (`app_public`), before rendering: the weak ETag the feed this token names would answer now — one statement
 * (the SECURITY DEFINER `calendar_feed_tag`: no names, no texts, no render, no gzip), so a matching If-None-Match is a
 * 304 at once. `CALENDAR_FEED_NOT_FOUND` like `calendarFeed`.
 */
export async function calendarFeedTag(token: string, opts: { locale?: string; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const range = feedRange(now);
  const hashes = tokenHashes(token);
  const found = await withPublicRead(async (tx) => {
    for (const hash of hashes) {
      const f = await repo.feedFingerprint(tx, hash, range, FEED_MAX_EVENTS);
      if (f) return f;
    }
    return null;
  });
  if (!found) throw new AppError('CALENDAR_FEED_NOT_FOUND');
  return feedTag(found, feedLocale(opts.locale), now);
}

/**
 * feed-api (`app_public`, no tenant): the ICS document of the live feed this token names — one statement (the
 * SECURITY DEFINER lookup), then rendered in `locale` (the type names and the attendees line). Unknown, rotated,
 * revoked tokens and members who lost access (deactivated, demoted out of the CRM roles, login disabled, agency
 * suspended) answer `CALENDAR_FEED_NOT_FOUND`.
 */
export async function calendarFeed(
  token: string,
  opts: { locale?: string; now?: Date } = {},
): Promise<CalendarFeedFile> {
  const now = opts.now ?? new Date();
  const range = feedRange(now);
  const hashes = tokenHashes(token);
  // the current key, then (inside its window) the previous one: a URL issued before a rotation keeps working
  const rows = await withPublicRead(async (tx) => {
    for (const hash of hashes) {
      const found = await repo.feedEvents(tx, hash, range, FEED_MAX_EVENTS);
      if (found) return found;
    }
    return null;
  });
  if (!rows) throw new AppError('CALENDAR_FEED_NOT_FOUND');
  const locale = feedLocale(opts.locale);
  // the weak ETag `calendarFeedTag` answers for the same feed, computed from these rows (no second statement)
  return renderCalendarFeed(rows, { locale, now, etag: feedTag(repo.fingerprintOf(rows), locale, now) });
}
