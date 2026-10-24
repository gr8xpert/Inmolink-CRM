import type { Tx } from '@inmolink/db';
import { notificationPreferences, notifications } from '@inmolink/db/schema/notifications';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

/**
 * notifications queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/notifications`. Every statement names the agency and the recipient, so each one is
 * served by an index led by `(agency_id, user_id)` in every month's partition. `created_at` is written at millisecond
 * precision; keysets compare the raw column (`keysetAfterRaw`, S11-F9: an index condition under RLS).
 */

export interface PreferenceRow {
  type: string;
  enabled: boolean;
  inApp: boolean;
  email: boolean;
}

/** Every channel on: a member who never chose anything gets every type in-app and in the digest. */
export const DEFAULT_PREFERENCE = { enabled: true, inApp: true, email: true } as const;

/** S11-05: preferences for one type of members of many agencies (one statement), keyed `agencyId:userId`. */
export async function preferencesAcross(
  tx: Tx,
  pairs: readonly { agencyId: string; userId: string }[],
  type: string,
): Promise<Map<string, PreferenceRow>> {
  if (pairs.length === 0) return new Map();
  const rows = await tx
    .select({
      agencyId: notificationPreferences.agencyId,
      userId: notificationPreferences.userId,
      type: notificationPreferences.type,
      enabled: notificationPreferences.enabled,
      inApp: notificationPreferences.inApp,
      email: notificationPreferences.email,
    })
    .from(notificationPreferences)
    .where(
      and(
        inArray(notificationPreferences.agencyId, [...new Set(pairs.map((p) => p.agencyId))]),
        inArray(notificationPreferences.userId, [...new Set(pairs.map((p) => p.userId))]),
        eq(notificationPreferences.type, type),
      ),
    );
  return new Map(rows.map(({ agencyId, userId, ...pref }) => [`${agencyId}:${userId}`, pref]));
}

export interface NewNotification {
  id: string;
  agencyId: string;
  userId: string;
  createdAt: Date;
  type: string;
  actorUserId: string | null;
  params: Record<string, string | number>;
  link: string | null;
  sourceKey: string | null;
  inApp: boolean;
  emailPending: boolean;
}

const dtoColumns = {
  id: notifications.id,
  type: notifications.type,
  params: notifications.params,
  link: notifications.link,
  actorUserId: notifications.actorUserId,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
};
export type NotificationRow = {
  id: string;
  type: string;
  params: unknown;
  link: string | null;
  actorUserId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

const uuids = (values: readonly string[]) => sql`${sql.param(values)}::uuid[]`;
const times = (values: readonly Date[]) => sql`${sql.param(values.map((d) => d.toISOString()))}::timestamptz[]`;

/** The recipients' choices for one type (one statement, the primary key). Missing users have the default. */
export async function preferencesFor(
  tx: Tx,
  agencyId: string,
  userIds: readonly string[],
  type: string,
): Promise<Map<string, PreferenceRow>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx
    .select({
      userId: notificationPreferences.userId,
      type: notificationPreferences.type,
      enabled: notificationPreferences.enabled,
      inApp: notificationPreferences.inApp,
      email: notificationPreferences.email,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.agencyId, agencyId),
        inArray(notificationPreferences.userId, [...userIds]),
        eq(notificationPreferences.type, type),
      ),
    );
  return new Map(rows.map(({ userId, ...pref }) => [userId, pref]));
}

/** One member's choices (the rows they saved; the service fills in the defaults). */
export async function listPreferences(tx: Tx, agencyId: string, userId: string): Promise<PreferenceRow[]> {
  return tx
    .select({
      type: notificationPreferences.type,
      enabled: notificationPreferences.enabled,
      inApp: notificationPreferences.inApp,
      email: notificationPreferences.email,
    })
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.agencyId, agencyId), eq(notificationPreferences.userId, userId)));
}

export async function upsertPreference(
  tx: Tx,
  row: { agencyId: string; userId: string } & PreferenceRow,
): Promise<PreferenceRow> {
  const [saved] = await tx
    .insert(notificationPreferences)
    .values(row)
    .onConflictDoUpdate({
      target: [notificationPreferences.agencyId, notificationPreferences.userId, notificationPreferences.type],
      set: { enabled: row.enabled, inApp: row.inApp, email: row.email, updatedAt: sql`now()` },
    })
    .returning({
      type: notificationPreferences.type,
      enabled: notificationPreferences.enabled,
      inApp: notificationPreferences.inApp,
      email: notificationPreferences.email,
    });
  if (!saved) throw new Error('notification preference upsert returned nothing');
  return saved;
}

/**
 * One multi-row INSERT in a member's request. No RETURNING: the rows are colleagues' (RLS lets a member insert them but
 * read only their own) — nor ON CONFLICT, whose new row must pass the SELECT policy. Hence no `source_key` here: idempotent
 * emitters are workers (`insertNotificationsReturning`).
 */
export async function insertNotifications(tx: Tx, rows: readonly NewNotification[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(notifications).values([...rows]);
}

/** Worker (`app_system`) form: what was inserted, so the result and the event name only rows that exist. */
export async function insertNotificationsReturning(
  tx: Tx,
  rows: readonly NewNotification[],
): Promise<{ id: string; userId: string }[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(notifications)
    .values([...rows])
    .onConflictDoNothing(SOURCE_CONFLICT)
    .returning({ id: notifications.id, userId: notifications.userId });
}

const SOURCE_CONFLICT = {
  target: [notifications.agencyId, notifications.userId, notifications.sourceKey, notifications.createdAt],
  where: sql`${notifications.sourceKey} is not null`,
};

/** The member's feed, newest first (keyset on the raw `created_at`, then id: `notifications_feed_idx`). `limit + 1` rows. */
export async function listFeed(
  tx: Tx,
  agencyId: string,
  userId: string,
  q: { limit: number; cursor?: KeysetCursor; unread?: boolean },
): Promise<(NotificationRow & { atUs: string })[]> {
  return tx
    .select({ ...dtoColumns, atUs: keysetStamp(notifications.createdAt) })
    .from(notifications)
    .where(
      and(
        eq(notifications.agencyId, agencyId),
        eq(notifications.userId, userId),
        eq(notifications.inApp, true),
        q.unread ? isNull(notifications.readAt) : undefined,
        keysetAfterRaw(notifications.createdAt, notifications.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(notifications.createdAt, notifications.id, 'desc'))
    .limit(q.limit + 1);
}

/** Unread in-app notifications, counted up to `cap + 1` (the partial unread index; never a full count). */
export async function countUnread(tx: Tx, agencyId: string, userId: string, cap: number): Promise<number> {
  const result = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select 1 from ${notifications}
       where ${notifications.agencyId} = ${agencyId} and ${notifications.userId} = ${userId}
         and ${notifications.inApp} and ${notifications.readAt} is null
       limit ${cap + 1}
    ) t`);
  return result.rows[0]?.n ?? 0;
}

/** Marks these of the member's unread notifications read, each by its primary key (one partition each). */
export async function markRead(
  tx: Tx,
  agencyId: string,
  userId: string,
  keys: readonly { id: string; at: Date }[],
): Promise<number> {
  if (keys.length === 0) return 0;
  const result = await tx.execute(sql`
    update ${notifications} set read_at = now()
     where agency_id = ${agencyId} and user_id = ${userId} and in_app and read_at is null
       and (id, created_at) in (select * from unnest(${uuids(keys.map((k) => k.id))}, ${times(keys.map((k) => k.at))}))`);
  return result.rowCount ?? 0;
}

/**
 * Marks the member's newest `max` unread notifications read; how many changed. The caller asks again while it
 * changed `max` (bounded statements: one call never rewrites a backlog of thousands).
 */
export async function markAllRead(tx: Tx, agencyId: string, userId: string, max: number): Promise<number> {
  const result = await tx.execute(sql`
    update ${notifications} n set read_at = now()
      from (
        select id, created_at from ${notifications}
         where agency_id = ${agencyId} and user_id = ${userId} and in_app and read_at is null
         order by created_at desc, id desc
         limit ${max}
      ) c
     where n.agency_id = ${agencyId} and n.user_id = ${userId} and n.id = c.id and n.created_at = c.created_at`);
  return result.rowCount ?? 0;
}

/**
 * S11-03: the member's unread notifications of one type and link raised after `since` read (a chat thread read in the
 * dashboard: its `CHAT_MESSAGE` notifications are seen, so the digest does not mail them). Unread in the feed or waiting
 * for the digest (`notifications_unread_idx` / `notifications_digest_idx`, the months since `since` only), ≤ `max`.
 */
export function markLinkReadStatement(
  agencyId: string,
  userId: string,
  type: string,
  link: string,
  since: Date,
  max: number,
) {
  return sql`
    update ${notifications} n set read_at = now()
      from (
        select id, created_at from ${notifications}
         where agency_id = ${agencyId} and user_id = ${userId} and read_at is null and (in_app or email_pending)
           and type = ${type} and link = ${link} and created_at > ${since.toISOString()}::timestamptz
         limit ${max}
      ) c
     where n.agency_id = ${agencyId} and n.user_id = ${userId} and n.id = c.id and n.created_at = c.created_at`;
}

export async function markLinkRead(
  tx: Tx,
  agencyId: string,
  userId: string,
  type: string,
  link: string,
  since: Date,
  max: number,
): Promise<number> {
  const result = await tx.execute(markLinkReadStatement(agencyId, userId, type, link, since, max));
  return result.rowCount ?? 0;
}

/**
 * Worker (`app_system`): the unread in-app notifications among `keys` (id + time: one partition each), to push live.
 * Read or unknown ones (an emitter's duplicate skipped on insert) are left out.
 */
export async function loadForPush(
  tx: Tx,
  agencyId: string,
  keys: readonly { id: string; at: Date }[],
): Promise<(NotificationRow & { userId: string })[]> {
  if (keys.length === 0) return [];
  return tx
    .select({ ...dtoColumns, userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.agencyId, agencyId),
        eq(notifications.inApp, true),
        isNull(notifications.readAt),
        sql`(${notifications.id}, ${notifications.createdAt}) in (select * from unnest(${uuids(keys.map((k) => k.id))}, ${times(keys.map((k) => k.at))}))`,
      ),
    )
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
}

export interface DigestRow extends NotificationRow {
  inApp: boolean;
}

/**
 * Worker (`app_system`): claims the member's notifications waiting for the digest that were raised at or before
 * `cutoff`, oldest first, at most `limit` (`FOR UPDATE SKIP LOCKED`: concurrent digests of one member take different
 * rows; joined back on the primary key). Claimed rows leave the queue (`email_pending` false, `digested_at` now)
 * whether or not they are mailed. `nextAt`: the oldest one still waiting after the cutoff (its digest comes later).
 */
export async function claimDigest(
  tx: Tx,
  agencyId: string,
  userId: string,
  cutoff: Date,
  limit: number,
): Promise<{ rows: DigestRow[]; nextAt: Date | null }> {
  const result = await tx.execute<{
    id: string;
    type: string;
    params: unknown;
    link: string | null;
    actor_user_id: string | null;
    read_at: string | null;
    created_at: string;
    in_app: boolean;
  }>(sql`
    with c as (
      select id, created_at from ${notifications}
       where agency_id = ${agencyId} and user_id = ${userId} and email_pending
         and created_at <= ${cutoff.toISOString()}::timestamptz
       order by created_at, id
       limit ${limit}
       for update skip locked
    )
    update ${notifications} n set email_pending = false, digested_at = now()
      from c
     where n.agency_id = ${agencyId} and n.user_id = ${userId} and (n.id, n.created_at) = (c.id, c.created_at)
    returning n.id, n.type, n.params, n.link, n.actor_user_id, n.read_at, n.created_at, n.in_app`);
  const next = await tx.execute<{ at: string }>(sql`
    select created_at as at from ${notifications}
     where agency_id = ${agencyId} and user_id = ${userId} and email_pending
       and created_at > ${cutoff.toISOString()}::timestamptz
     order by created_at limit 1`);
  const rows = result.rows
    .map((r) => ({
      id: r.id,
      type: r.type,
      params: r.params,
      link: r.link,
      actorUserId: r.actor_user_id,
      readAt: r.read_at ? new Date(r.read_at) : null,
      createdAt: new Date(r.created_at),
      inApp: r.in_app,
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  const nextAt = next.rows[0]?.at;
  return { rows, nextAt: nextAt ? new Date(nextAt) : null };
}

/** Worker (`app_system`): gives a digest's claim back (the send is known not to have gone out). */
export async function releaseDigest(
  tx: Tx,
  agencyId: string,
  userId: string,
  keys: readonly { id: string; at: Date }[],
): Promise<void> {
  if (keys.length === 0) return;
  await tx.execute(sql`
    update ${notifications} set email_pending = true, digested_at = null
     where agency_id = ${agencyId} and user_id = ${userId}
       and (id, created_at) in (select * from unnest(${uuids(keys.map((k) => k.id))}, ${times(keys.map((k) => k.at))}))`);
}

/**
 * S11-05 (app_system): the members of these agencies a worker raised `sourceKey` for at `at` — one statement on
 * `notifications_source_uq` (agency, user, source key, time: one partition).
 */
export async function recipientsOfSource(
  tx: Tx,
  q: { agencyIds: readonly string[]; type: string; sourceKey: string; at: Date },
): Promise<{ agencyId: string; userId: string }[]> {
  if (q.agencyIds.length === 0) return [];
  return tx
    .select({ agencyId: notifications.agencyId, userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        inArray(notifications.agencyId, [...q.agencyIds]),
        eq(notifications.sourceKey, q.sourceKey),
        eq(notifications.createdAt, q.at),
        eq(notifications.type, q.type),
      ),
    );
}
