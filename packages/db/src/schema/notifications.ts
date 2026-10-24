import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * Tables owned by the notifications module (PATTERNS §2). Only `packages/core/src/modules/notifications` imports
 * this file (`pnpm check:boundaries`). Both tables are STRICT: a notification is about the agency's own work and is
 * read only by its recipient (`userSelect`, `user_id = app_user_id()`). `notifications` is partitioned by month
 * (pg_partman, S11-04, `.claude/rules/database.md`).
 */

/** A notification type's format (the catalog is `NOTIFICATION_TYPES` in contracts: adding one needs no migration). */
const TYPE_FORMAT = '^[A-Z][A-Z0-9_]{1,47}$';

/**
 * One notification for one member (S11-04): written by `notifications.notify` in the emitting transaction, pushed
 * to the member's sockets (apps/realtime) and, when still unread after 5 minutes, sent in an e-mail digest.
 * `user_id` has no foreign key (like `activities.actor_user_id`): a removed member's rows age out with their month.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').notNull(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** When it was raised, to the millisecond: the partition key and the feed's sort key (keyset on the raw column). */
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`date_trunc('milliseconds', now(), 'UTC')`),
    /** The recipient (a member of the agency). */
    userId: uuid('user_id').notNull(),
    /** `NOTIFICATION_TYPES` (contracts); format-checked only. */
    type: text('type').notNull(),
    /** The member whose action raised it; null for system notifications. */
    actorUserId: uuid('actor_user_id'),
    /** Small display values for the type's message (`{ subject }`): strings and numbers, ≤ 2 KB. */
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    /** Where the dashboard opens it: a path inside the app (`/crm/leads/…`), never a URL. */
    link: text('link'),
    /** The emitter's idempotency key (e.g. its outbox event id), unique per recipient and time. */
    sourceKey: text('source_key'),
    /** Shown in the in-app feed and counted as unread (the type's in-app preference when it was raised). */
    inApp: boolean('in_app').notNull().default(true),
    /** Waiting for the recipient's e-mail digest (the type's e-mail preference when it was raised). */
    emailPending: boolean('email_pending').notNull().default(false),
    /** When the digest job took it (sent, or skipped because it was read or the type turned off meanwhile). */
    digestedAt: timestamp('digested_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    // the member's feed: where agency_id = ? and user_id = ? and in_app and (created_at, id) < (?, ?)
    // order by created_at desc, id desc (keyset)
    index('notifications_feed_idx').on(t.agencyId, t.userId, t.createdAt, t.id).where(sql`${t.inApp}`),
    // the unread count and the unread feed: where agency_id = ? and user_id = ? and in_app and read_at is null
    index('notifications_unread_idx')
      .on(t.agencyId, t.userId, t.createdAt, t.id)
      .where(sql`${t.inApp} and ${t.readAt} is null`),
    // the digest claim: where agency_id = ? and user_id = ? and email_pending and created_at <= ? order by created_at, id
    index('notifications_digest_idx').on(t.agencyId, t.userId, t.createdAt, t.id).where(sql`${t.emailPending}`),
    // idempotent emitters (a redelivered event raises nothing more); includes the partition key
    uniqueIndex('notifications_source_uq')
      .on(t.agencyId, t.userId, t.sourceKey, t.createdAt)
      .where(sql`${t.sourceKey} is not null`),
    check('notifications_ms_ck', sql`${t.createdAt} = date_trunc('milliseconds', ${t.createdAt}, 'UTC')`),
    check('notifications_type_ck', sql.raw(`"notifications"."type" ~ '${TYPE_FORMAT}'`)),
    check(
      'notifications_params_ck',
      sql`jsonb_typeof(${t.params}) = 'object' and octet_length(${t.params}::text) <= 2048`,
    ),
    // a path inside the app: '/' then a path character (never '//' or '/', which browsers read as another host)
    // a path inside the app: '/' then anything but '/' or a backslash (browsers read '//x' and '/\x' as another host)
    check(
      'notifications_link_ck',
      sql`${t.link} is null or (left(${t.link}, 1) = '/' and substr(${t.link}, 2, 1) not in ('', '/', chr(92)) and length(${t.link}) <= 300)`,
    ),
    check('notifications_source_ck', sql`${t.sourceKey} is null or length(${t.sourceKey}) between 1 and 200`),
  ],
);

/**
 * A member's choice for one notification type (S11-04). No row = the type's default (every channel on). `enabled`
 * false turns the type off on every channel; otherwise `in_app` and `email` choose the channels.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    inApp: boolean('in_app').notNull().default(true),
    email: boolean('email').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the member's preferences, and the recipients' of one notify (where agency_id = ? and user_id = any(?))
    primaryKey({ columns: [t.agencyId, t.userId, t.type] }),
    check('notification_preferences_type_ck', sql.raw(`"notification_preferences"."type" ~ '${TYPE_FORMAT}'`)),
  ],
);
