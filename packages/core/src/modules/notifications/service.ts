import {
  type ListNotificationsQuery,
  type MarkAllNotificationsReadDto,
  type MarkNotificationsReadBody,
  type MarkNotificationsReadDto,
  NOTIFICATION_LIMITS,
  NOTIFICATION_TYPES,
  type NotificationDto,
  NotificationLink,
  type NotificationPage,
  NotificationParams,
  type NotificationPreferenceDto,
  type NotificationPreferencesDto,
  type NotificationPush,
  NotificationType,
  REALTIME_NOTIFICATION_EVENT,
  REALTIME_NOTIFICATIONS_NAMESPACE,
  type UnreadCountDto,
  type UpdateNotificationPreferenceBody,
} from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { publishUserEvents, type UserEvent } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import { EmailSendError, mailer } from '@inmolink/platform/email';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { z } from 'zod';
import type { Ctx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as identity from '../identity';
import { renderDigest } from './digest-email';
import { notificationsEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * notifications use cases (PATTERNS §7).
 *
 * Raising (the API other modules call — see index.ts): `notify(ctx, …)` in the emitting request's transaction, or
 * `raiseNotifications(tx, …)` from a worker job (`withSystem`, e.g. a reaction to another agency's event). Both read
 * the recipients' preference for the type and write one row per recipient whose type is on (`enabled`, and in-app
 * and/or e-mail), plus one `notifications.notification.created` event — all in the caller's transaction, so the
 * notifications exist if and only if the change commits. A recipient whose type is off gets no row at all: nothing
 * in the feed, nothing pushed, nothing mailed.
 *
 * Delivery (worker, after commit): `pushNotifications` publishes each unread in-app row to the recipient's sockets
 * (apps/realtime, `/notifications` namespace, room of that user only); `sendDigest` (5 minutes after the first one,
 * throttled per member) mails the member what is still unread and whose type still has e-mail on — read in-app
 * meanwhile means seen (the member was online), so it is not mailed.
 */

const userIdOf = (ctx: Ctx): string => {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return ctx.actor.userId;
};

/** What `notify` / `raiseNotifications` take (validated: other modules' code is trusted, its data is not). */
export const NotifyInput = z.strictObject({
  type: NotificationType,
  /** Members of the agency to notify (≤ 100); the acting member is left out, as are non-members. */
  userIds: z.array(z.uuid()).min(1).max(NOTIFICATION_LIMITS.recipients),
  /** Display values for the type's message: `{ subject, actor }`. Names and codes, never contact details. */
  params: NotificationParams.default({}),
  /** A path inside the dashboard to open it. */
  link: NotificationLink.nullable().default(null),
  /**
   * Workers only (`raiseNotifications`; `notify` refuses it — RLS): idempotent emitters reacting to an outbox event pass a stable key, e.g. the event's id, plus `at` = the
   * event's time. A redelivery with the same key and time raises nothing more.
   */
  sourceKey: z.string().min(1).max(NOTIFICATION_LIMITS.sourceKeyChars).optional(),
  at: z.date().optional(),
});
export type NotifyInput = z.input<typeof NotifyInput>;

export interface NotifyResult {
  /** Notification ids written, by recipient (a recipient whose type is off is absent). */
  notified: { userId: string; notificationId: string }[];
}

async function raise(
  tx: Tx,
  agencyId: string,
  actor: string | null,
  raw: NotifyInput,
  mode: 'member' | 'system',
): Promise<NotifyResult> {
  const parsed = NotifyInput.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', { reason: 'notification', issues: parsed.error.issues });
  const input = parsed.data;
  if (input.sourceKey && !input.at)
    throw new AppError('VALIDATION_FAILED', { field: 'at', reason: 'sourceKey needs at' });
  // a member's request cannot use ON CONFLICT on colleagues' rows (RLS): sourceKey is the workers' (raiseNotifications)
  if (mode === 'member' && input.sourceKey) {
    throw new AppError('VALIDATION_FAILED', { field: 'sourceKey', reason: 'raiseNotifications only' });
  }
  const wanted = [...new Set(input.userIds)].filter((u) => u !== actor);
  if (wanted.length === 0) return { notified: [] };
  const members = await identity.activeClientMembersAmong(tx, agencyId, actor ? [...wanted, actor] : wanted);
  const recipients = wanted.filter((u) => members.has(u));
  // another agency's member (a cross-agency reaction) is not named: the recipient sees `params.actor` only
  const actorUserId = actor && members.has(actor) ? actor : null;
  if (recipients.length === 0) return { notified: [] };

  const prefs = await repo.preferencesFor(tx, agencyId, recipients, input.type);
  // a JS Date holds milliseconds: the column's precision (`notifications_ms_ck`)
  const createdAt = input.at ?? clock.now();
  const rows: repo.NewNotification[] = [];
  for (const userId of recipients) {
    const pref = prefs.get(userId) ?? repo.DEFAULT_PREFERENCE;
    if (!pref.enabled || (!pref.inApp && !pref.email)) continue;
    rows.push({
      id: newId(),
      agencyId,
      userId,
      createdAt,
      type: input.type,
      actorUserId,
      params: input.params,
      link: input.link,
      sourceKey: input.sourceKey ?? null,
      inApp: pref.inApp,
      emailPending: pref.email,
    });
  }
  if (rows.length === 0) return { notified: [] };
  let written = rows;
  if (mode === 'system') {
    // a worker reads what it inserted: a redelivered event's rows (`sourceKey`) are neither returned nor announced
    const inserted = new Set((await repo.insertNotificationsReturning(tx, rows)).map((r) => r.id));
    written = rows.filter((r) => inserted.has(r.id));
    if (written.length === 0) return { notified: [] };
  } else {
    await repo.insertNotifications(tx, rows);
  }
  await emit(
    tx,
    notificationsEvents.created({
      agencyId,
      items: written.map((r) => ({
        id: r.id,
        userId: r.userId,
        at: r.createdAt.getTime(),
        inApp: r.inApp,
        email: r.emailPending,
      })),
    }),
  );
  return { notified: written.map((r) => ({ userId: r.userId, notificationId: r.id })) };
}

/**
 * Raises one notification per recipient in the caller's transaction (3–4 statements: members, preferences, insert,
 * event). For a module's request that notifies colleagues of the same agency: S11-03 chat messages, a lead assigned.
 * No authorization of its own — the calling use case authorized its action; recipients are narrowed to active
 * members of `ctx`'s agency, the actor left out.
 */
export async function notify(ctx: Ctx, input: NotifyInput): Promise<NotifyResult> {
  return raise(ctx.tx, ctx.tenant.agencyId, ctx.actor.kind === 'user' ? ctx.actor.userId : null, input, 'member');
}

/**
 * Worker form of `notify` (PATTERNS §12, cross-module functions for workers): in a job's own `withSystem` transaction,
 * for reactions that cross agencies (S11-02: agency B's viewing request notifies agency A's listing agent; S11-05:
 * a network post notifies subscribers of other agencies). Pass `sourceKey` + `at` (the event's id and time) so a
 * retried job raises nothing twice. Never called from request code.
 */
export async function raiseNotifications(
  tx: Tx,
  input: NotifyInput & { agencyId: string; actorUserId?: string | null },
): Promise<NotifyResult> {
  const { agencyId, actorUserId, ...rest } = input;
  return raise(tx, agencyId, actorUserId ?? null, rest, 'system');
}

/**
 * `raiseNotifications` for many agencies at once (S11-05: a network post told to the subscribers of a hundred agencies
 * in one transaction): one statement each for the recipients' memberships, their preferences, the insert and the
 * agencies' events, whatever the number of agencies. Same rules per item as `raiseNotifications` (workers only,
 * `sourceKey` + `at` for idempotency; inactive members and types turned off get nothing).
 */
export async function raiseNotificationsAcross(
  tx: Tx,
  type: NotificationType,
  items: readonly (Omit<NotifyInput, 'type'> & { agencyId: string })[],
): Promise<NotifyResult & { agencies: number }> {
  const parsed = items.map(({ agencyId, ...rest }) => {
    const r = NotifyInput.safeParse({ ...rest, type });
    if (!r.success) throw new AppError('VALIDATION_FAILED', { reason: 'notification', issues: r.error.issues });
    if (r.data.sourceKey && !r.data.at) {
      throw new AppError('VALIDATION_FAILED', { field: 'at', reason: 'sourceKey needs at' });
    }
    return { agencyId, input: r.data };
  });
  const pairs = parsed.flatMap((p) =>
    [...new Set(p.input.userIds)].map((userId) => ({ agencyId: p.agencyId, userId })),
  );
  if (pairs.length === 0) return { notified: [], agencies: 0 };
  const members = await identity.activeClientMembersAcross(tx, pairs);
  const recipients = pairs.filter((p) => members.has(`${p.agencyId}:${p.userId}`));
  const prefs = await repo.preferencesAcross(tx, recipients, type);
  const rows: repo.NewNotification[] = [];
  for (const { agencyId, input } of parsed) {
    const createdAt = input.at ?? clock.now();
    for (const userId of new Set(input.userIds)) {
      if (!members.has(`${agencyId}:${userId}`)) continue;
      const pref = prefs.get(`${agencyId}:${userId}`) ?? repo.DEFAULT_PREFERENCE;
      if (!pref.enabled || (!pref.inApp && !pref.email)) continue;
      rows.push({
        id: newId(),
        agencyId,
        userId,
        createdAt,
        type,
        actorUserId: null,
        params: input.params,
        link: input.link,
        sourceKey: input.sourceKey ?? null,
        inApp: pref.inApp,
        emailPending: pref.email,
      });
    }
  }
  if (rows.length === 0) return { notified: [], agencies: 0 };
  // a redelivered event's rows (`sourceKey`) are neither returned nor announced
  const inserted = new Set((await repo.insertNotificationsReturning(tx, rows)).map((r) => r.id));
  const written = rows.filter((r) => inserted.has(r.id));
  const byAgency = new Map<string, repo.NewNotification[]>();
  for (const r of written) byAgency.set(r.agencyId, [...(byAgency.get(r.agencyId) ?? []), r]);
  await emit(
    tx,
    [...byAgency].flatMap(([agencyId, list]) => {
      const events = [];
      // an event announces at most `recipients` rows
      for (let i = 0; i < list.length; i += NOTIFICATION_LIMITS.recipients) {
        events.push(
          notificationsEvents.created({
            agencyId,
            items: list.slice(i, i + NOTIFICATION_LIMITS.recipients).map((r) => ({
              id: r.id,
              userId: r.userId,
              at: r.createdAt.getTime(),
              inApp: r.inApp,
              email: r.emailPending,
            })),
          }),
        );
      }
      return events;
    }),
  );
  return { notified: written.map((r) => ({ userId: r.userId, notificationId: r.id })), agencies: byAgency.size };
}

/**
 * Worker form (PATTERNS §12, S11-05): who among these agencies' members was raised `sourceKey` at `at` (one query) —
 * a later notification about the same thing can leave them out. `agencyId:userId` keys.
 */
export async function recipientsOfSource(
  tx: Tx,
  q: { agencyIds: readonly string[]; type: NotificationType; sourceKey: string; at: Date },
): Promise<Set<string>> {
  const rows = await repo.recipientsOfSource(tx, q);
  return new Set(rows.map((r) => `${r.agencyId}:${r.userId}`));
}

export function toNotificationDto(row: repo.NotificationRow): NotificationDto {
  return {
    id: row.id,
    type: row.type as NotificationDto['type'],
    params: (row.params ?? {}) as NotificationDto['params'],
    link: row.link,
    actorUserId: row.actorUserId,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Types this build knows: a row of a type removed from the catalog is not served (the DTO's enum would refuse it). */
const KNOWN_TYPES = new Set<string>(NOTIFICATION_TYPES);

/** `GET /v1/notifications`: the caller's feed, newest first, keyset (≤ 100). One query. */
export async function listNotifications(ctx: Ctx, query: ListNotificationsQuery): Promise<NotificationPage> {
  assertCan(ctx, 'notifications.read');
  const rows = await repo.listFeed(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx), {
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
    unread: query.unread,
  });
  const page = toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }),
    (r) => r,
  );
  return {
    items: page.items.filter((r) => KNOWN_TYPES.has(r.type)).map(toNotificationDto),
    nextCursor: page.nextCursor,
  };
}

async function unreadOf(tx: Tx, agencyId: string, userId: string): Promise<UnreadCountDto> {
  const n = await repo.countUnread(tx, agencyId, userId, NOTIFICATION_LIMITS.unreadCap);
  return { count: Math.min(n, NOTIFICATION_LIMITS.unreadCap), capped: n > NOTIFICATION_LIMITS.unreadCap };
}

/** `GET /v1/notifications/unread-count`: one bounded count (≤ 100 index entries). */
export async function getUnreadCount(ctx: Ctx): Promise<UnreadCountDto> {
  assertCan(ctx, 'notifications.read');
  return unreadOf(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx));
}

/** `POST /v1/notifications/read`: these of the caller's notifications read (by primary key); the new unread count. */
export async function markNotificationsRead(
  ctx: Ctx,
  body: MarkNotificationsReadBody,
): Promise<MarkNotificationsReadDto> {
  assertCan(ctx, 'notifications.markRead');
  const userId = userIdOf(ctx);
  const keys = body.items.map((k) => ({ id: k.id, at: new Date(k.createdAt) }));
  const updated = await repo.markRead(ctx.tx, ctx.tenant.agencyId, userId, keys);
  return { updated, unread: await unreadOf(ctx.tx, ctx.tenant.agencyId, userId) };
}

/**
 * `POST /v1/notifications/read-all`: the caller's newest `markAllMax` (500) unread notifications read in one bounded
 * statement; `more` while older unread ones remain (the client calls again).
 */
export async function markAllNotificationsRead(ctx: Ctx): Promise<MarkAllNotificationsReadDto> {
  assertCan(ctx, 'notifications.markRead');
  const userId = userIdOf(ctx);
  const updated = await repo.markAllRead(ctx.tx, ctx.tenant.agencyId, userId, NOTIFICATION_LIMITS.markAllMax);
  const unread = await unreadOf(ctx.tx, ctx.tenant.agencyId, userId);
  return { updated, more: unread.count > 0, unread };
}

/**
 * For other modules' read actions (S11-03: a chat thread read): the caller's unread notifications of `type` linking to
 * `link` raised after `since` become read (≤ 100, one statement), so the e-mail digest leaves them out. The badge is the
 * client's to refresh (the read answer tells it); no push. No authorization of its own: the
 * calling use case authorized the read; only the caller's own rows change (RLS `user_id = app_user_id()`).
 */
export async function markLinkRead(
  ctx: Ctx,
  input: { type: NotificationType; link: string; since: Date },
): Promise<number> {
  const type = NotificationType.parse(input.type);
  const link = NotificationLink.parse(input.link);
  return repo.markLinkRead(
    ctx.tx,
    ctx.tenant.agencyId,
    userIdOf(ctx),
    type,
    link,
    input.since,
    NOTIFICATION_LIMITS.recipients,
  );
}

/** `GET /v1/notifications/preferences`: every type of the catalog with the caller's choice (default: all on). */
export async function getNotificationPreferences(ctx: Ctx): Promise<NotificationPreferencesDto> {
  assertCan(ctx, 'notifications.read');
  const saved = new Map(
    (await repo.listPreferences(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx))).map((p) => [p.type, p]),
  );
  return {
    items: NOTIFICATION_TYPES.map((type) => {
      const p = saved.get(type) ?? repo.DEFAULT_PREFERENCE;
      return { type, enabled: p.enabled, inApp: p.inApp, email: p.email };
    }),
  };
}

/**
 * `PATCH /v1/notifications/preferences/:type`: the caller's own choice for one type (the others keep theirs). Takes
 * effect for notifications raised from now on, and for the e-mail digest of ones still waiting for it.
 */
export async function updateNotificationPreference(
  ctx: Ctx,
  type: NotificationPreferenceDto['type'],
  body: UpdateNotificationPreferenceBody,
): Promise<NotificationPreferenceDto> {
  assertCan(ctx, 'notifications.preferences');
  const userId = userIdOf(ctx);
  const current = (await repo.preferencesFor(ctx.tx, ctx.tenant.agencyId, [userId], type)).get(userId);
  const base = current ?? repo.DEFAULT_PREFERENCE;
  const saved = await repo.upsertPreference(ctx.tx, {
    agencyId: ctx.tenant.agencyId,
    userId,
    type,
    enabled: body.enabled ?? base.enabled,
    inApp: body.inApp ?? base.inApp,
    email: body.email ?? base.email,
  });
  return { type, enabled: saved.enabled, inApp: saved.inApp, email: saved.email };
}

/* ------------------------------------------------------------------ worker side (app_system) */

export interface PushTarget {
  agencyId: string;
  items: readonly { id: string; at: number }[];
}

/**
 * `notifications.pushRealtime`: each still-unread in-app notification of the event goes to its recipient's sockets
 * (`publish`: redis-cache pub/sub in one pipeline, fanned out by apps/realtime to the room of that agency's user on
 * `/notifications`). At least once — a retried job pushes again; clients drop ids they have. One read, then the
 * publish outside any transaction.
 */
export async function pushNotifications(
  p: PushTarget,
  publish: (events: readonly UserEvent[]) => Promise<void> = publishUserEvents,
): Promise<{ pushed: number }> {
  const rows = await withSystem('notifications.pushRealtime', (tx) =>
    repo.loadForPush(
      tx,
      p.agencyId,
      p.items.map((i) => ({ id: i.id, at: new Date(i.at) })),
    ),
  );
  const events: UserEvent[] = rows
    .filter((row) => KNOWN_TYPES.has(row.type))
    .map((row) => {
      const data: NotificationPush = { agencyId: p.agencyId, notification: toNotificationDto(row) };
      return {
        userId: row.userId,
        agencyId: p.agencyId,
        namespace: REALTIME_NOTIFICATIONS_NAMESPACE,
        event: REALTIME_NOTIFICATION_EVENT,
        data,
      };
    });
  if (events.length > 0) await publish(events);
  return { pushed: events.length };
}

/** The digest waits this long after a notification (PLAN §7 M12: 5-minute debounce for offline users). */
export const DIGEST_DELAY_MS = 5 * 60_000;

/** Notifications one digest takes; a member with more gets the next digest at once (`retryInMs` 0). */
export const DIGEST_BATCH = 200;

const wasNotSent = (err: unknown) => err instanceof TypeError || (err instanceof EmailSendError && err.notSent);

export interface DigestResult {
  sent: boolean;
  mailed: number;
  /** Notifications still wait (raised after the cutoff, or a full batch): run again in this many ms; null: none. */
  retryInMs: number | null;
}

/**
 * `notifications.sendDigest`: claims what waits for the member's digest and is at least `DIGEST_DELAY_MS` old (oldest
 * first, ≤ `DIGEST_BATCH`, `SKIP LOCKED`), keeps what is still unread and whose type still has e-mail on (the member's
 * preference now — turning a type off stops its waiting e-mails too), and mails those in one message, outside any
 * transaction, with the provider's idempotency key. Younger ones wait for their own 5 minutes (`retryInMs`). The claim
 * is given back only after a failure known to precede the send; after an ambiguous one it stays (a digest may be
 * lost, never doubled). Nothing to mail, or the member gone: nothing is sent. `now` is for tests.
 */
export async function sendDigest(
  p: { agencyId: string; userId: string },
  opts: { now?: Date } = {},
): Promise<DigestResult> {
  const now = opts.now ?? clock.now();
  const cutoff = new Date(now.getTime() - DIGEST_DELAY_MS);
  const claim = await withSystem('notifications.sendDigest claim', async (tx) => {
    const { rows: claimed, nextAt } = await repo.claimDigest(tx, p.agencyId, p.userId, cutoff, DIGEST_BATCH);
    const retryInMs =
      claimed.length === DIGEST_BATCH
        ? 0
        : nextAt
          ? Math.max(0, nextAt.getTime() + DIGEST_DELAY_MS - now.getTime())
          : null;
    if (claimed.length === 0) return { claimed, mailable: [], to: null, retryInMs };
    const saved = new Map((await repo.listPreferences(tx, p.agencyId, p.userId)).map((x) => [x.type, x]));
    const mailable = claimed.filter((n) => {
      const pref = saved.get(n.type) ?? repo.DEFAULT_PREFERENCE;
      return KNOWN_TYPES.has(n.type) && pref.enabled && pref.email && n.readAt === null;
    });
    const to = mailable.length > 0 ? await identity.memberRecipient(tx, p.agencyId, p.userId) : null;
    return { claimed, mailable, to, retryInMs };
  });
  const { retryInMs } = claim;
  if (!claim.to || claim.mailable.length === 0) return { sent: false, mailed: 0, retryInMs };
  const to = claim.to;
  const first = claim.mailable[0] as repo.DigestRow;
  try {
    await mailer().send({
      ...renderDigest({
        to: to.email,
        name: to.name,
        locale: to.locale,
        items: claim.mailable.map((n) => ({
          type: n.type,
          params: (n.params ?? {}) as Record<string, string | number>,
          createdAt: n.createdAt,
        })),
      }),
      idempotencyKey: `notifications-digest:${p.userId}:${first.id}`,
    });
  } catch (err) {
    if (wasNotSent(err)) {
      await withSystem('notifications.sendDigest release', (tx) =>
        repo.releaseDigest(
          tx,
          p.agencyId,
          p.userId,
          claim.claimed.map((n) => ({ id: n.id, at: n.createdAt })),
        ),
      );
    }
    throw err;
  }
  return { sent: true, mailed: claim.mailable.length, retryInMs };
}
