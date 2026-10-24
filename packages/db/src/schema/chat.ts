import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * Tables owned by the chat module (PATTERNS §2). Only `packages/core/src/modules/chat` imports this file
 * (`pnpm check:boundaries`).
 *
 * S11-03, chat (PLAN §7 M12). Like S11-02's viewing requests, every agency reads its own copy under one RLS policy:
 * - `chat_threads` — the agency's copy of a thread (`DIRECT`: colleagues of one agency; `VIEWING`: the two agencies of a
 *   viewing request, whose id the thread takes). A `VIEWING` copy appends the other agency's copy
 *   (`chat_threads_mirror`, SECURITY DEFINER), only for a viewing request between exactly those two agencies.
 * - `chat_participants` — the agency's members in a thread, with their read state and their thread list's sort key.
 * - `chat_messages` — the agency's copy of each message, readable by the thread's participants only (and its sender).
 *   A member's message appends the other agency's copy (`chat_messages_fanout`, SECURITY DEFINER) and moves both
 *   copies' threads and participants' `last_message_at`.
 * S11-05: a `NETWORK` thread is a reply to a network board post between the post's agency and the replying agency; like a
 * `VIEWING` thread, `chat_threads_mirror` appends the post's agency's copy (only for an open post of that agency) and
 * seats the post's author on it.
 * Nothing of a client is stored here: a viewing thread carries the listing's reference, never the registration.
 */

export const chatThreads = pgTable(
  'chat_threads',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** Shared by both agencies' copies; a `VIEWING` thread's is the viewing request's id. */
    id: uuid('id').notNull(),
    /** `DIRECT` or `VIEWING`. */
    kind: text('kind').notNull(),
    /** `VIEWING`: the other agency of the viewing request; `NETWORK`: the other agency of the reply (S11-05). */
    peerAgencyId: uuid('peer_agency_id'),
    /**
     * `NETWORK` only (S11-05): the network board post replied to — the thread between the post's agency and one replying
     * agency (both copies name it).
     */
    networkPostId: uuid('network_post_id'),
    /** `DIRECT`: the name its starter gave it. */
    title: text('title'),
    /** `VIEWING`: the listing's reference (set by the worker, both copies); `NETWORK`: the post's title. */
    subject: text('subject'),
    /** Null on the other agency's copy. */
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    /** `VIEWING`: the viewing request was declined, cancelled or expired — the thread is read-only (the worker's). */
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'chat_threads_pk', columns: [t.agencyId, t.id] }),
    check('chat_threads_kind_ck', sql`${t.kind} in ('DIRECT', 'VIEWING', 'NETWORK')`),
    check(
      'chat_threads_peer_ck',
      sql`(${t.kind} in ('VIEWING', 'NETWORK')) = (${t.peerAgencyId} is not null)
        and (${t.peerAgencyId} is null or ${t.peerAgencyId} <> ${t.agencyId})`,
    ),
    check('chat_threads_network_ck', sql`(${t.kind} = 'NETWORK') = (${t.networkPostId} is not null)`),
    // S11-05: one reply thread per post and replying agency, on each copy (a second reply joins it):
    // where agency_id = ? and network_post_id = ? and peer_agency_id = ?
    uniqueIndex('chat_threads_network_uq')
      .on(t.agencyId, t.networkPostId, t.peerAgencyId)
      .where(sql`${t.networkPostId} is not null`),
    check('chat_threads_title_ck', sql`${t.title} is null or char_length(${t.title}) between 1 and 120`),
    check('chat_threads_subject_ck', sql`${t.subject} is null or char_length(${t.subject}) between 1 and 120`),
  ],
);

export const chatParticipants = pgTable(
  'chat_participants',
  {
    agencyId: uuid('agency_id').notNull(),
    threadId: uuid('thread_id').notNull(),
    userId: uuid('user_id').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** The thread's latest message (kept by `chat_messages_fanout`): the member's thread list sorts on it. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    /** Read up to here (the member's own messages count as read). */
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    /** The latest unread message a `CHAT_MESSAGE` notification was raised for (the worker's): one per unread run. */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (t) => [
    // the fan-out and the membership checks: where agency_id = ? and thread_id = ? (and user_id = ?)
    primaryKey({ name: 'chat_participants_pk', columns: [t.agencyId, t.threadId, t.userId] }),
    // the member's threads: where agency_id = ? and user_id = ? and (last_message_at, thread_id) < (?, ?)
    // order by last_message_at desc, thread_id desc
    index('chat_participants_inbox_idx').on(t.agencyId, t.userId, t.lastMessageAt, t.threadId),
    // the worker's fan-out reads every agency's participants of one thread: where thread_id = ?
    index('chat_participants_thread_idx').on(t.threadId),
    foreignKey({
      name: 'chat_participants_thread_fk',
      columns: [t.agencyId, t.threadId],
      foreignColumns: [chatThreads.agencyId, chatThreads.id],
    }),
  ],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    /** The reading agency (each agency of the thread has its copy). */
    agencyId: uuid('agency_id').notNull(),
    /** Shared by both copies. */
    id: uuid('id').notNull(),
    threadId: uuid('thread_id').notNull(),
    senderAgencyId: uuid('sender_agency_id').notNull(),
    senderUserId: uuid('sender_user_id').notNull(),
    /** The sender's display name when sent (the other agency cannot read its members). */
    senderName: text('sender_name').notNull(),
    body: text('body').notNull(),
    /** The sender's idempotency key (their own copy only). */
    clientKey: uuid('client_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'chat_messages_pk', columns: [t.agencyId, t.id] }),
    // the thread's history: where agency_id = ? and thread_id = ? and (created_at, id) < (?, ?)
    // order by created_at desc, id desc
    index('chat_messages_thread_created_idx').on(t.agencyId, t.threadId, t.createdAt, t.id),
    // a retried send: where agency_id = ? and sender_user_id = ? and client_key = ?
    uniqueIndex('chat_messages_client_key_uq')
      .on(t.agencyId, t.senderUserId, t.clientKey)
      .where(sql`${t.clientKey} is not null`),
    foreignKey({
      name: 'chat_messages_thread_fk',
      columns: [t.agencyId, t.threadId],
      foreignColumns: [chatThreads.agencyId, chatThreads.id],
    }),
    check('chat_messages_body_ck', sql`char_length(${t.body}) between 1 and 4000`),
    check('chat_messages_sender_name_ck', sql`char_length(${t.senderName}) <= 200`),
  ],
);
