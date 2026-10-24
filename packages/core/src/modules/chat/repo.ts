import type { Tx } from '@inmolink/db';
import { chatMessages, chatParticipants, chatThreads } from '@inmolink/db/schema/chat';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

/**
 * chat queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor on raw columns
 * (`keysetAfterRaw`, S11-F9: an index condition under RLS). Queries only `@inmolink/db/schema/chat`. Request paths
 * name the agency (its own copy) and, for reads, the member; the worker reads both agencies' copies of one thread.
 */

export interface ThreadRow {
  id: string;
  kind: string;
  peerAgencyId: string | null;
  networkPostId: string | null;
  title: string | null;
  subject: string | null;
  createdAt: Date;
  lastMessageAt: Date;
  lastReadAt: Date | null;
  closedAt: Date | null;
}

const threadColumns = {
  id: chatThreads.id,
  kind: chatThreads.kind,
  peerAgencyId: chatThreads.peerAgencyId,
  networkPostId: chatThreads.networkPostId,
  title: chatThreads.title,
  subject: chatThreads.subject,
  createdAt: chatThreads.createdAt,
  lastMessageAt: chatParticipants.lastMessageAt,
  lastReadAt: chatParticipants.lastReadAt,
  closedAt: chatThreads.closedAt,
};

const memberJoin = (agencyId: string, userId: string) =>
  and(
    eq(chatParticipants.agencyId, agencyId),
    eq(chatParticipants.userId, userId),
    eq(chatThreads.agencyId, chatParticipants.agencyId),
    eq(chatThreads.id, chatParticipants.threadId),
  );

/** The thread as one of its participants sees it, or null (not a participant: the same answer as no thread). */
export async function threadForMember(
  tx: Tx,
  agencyId: string,
  userId: string,
  threadId: string,
): Promise<ThreadRow | null> {
  const [row] = await tx
    .select(threadColumns)
    .from(chatParticipants)
    .innerJoin(chatThreads, memberJoin(agencyId, userId))
    .where(eq(chatParticipants.threadId, threadId));
  return row ?? null;
}

/** The member's threads, latest activity first (`chat_participants_inbox_idx`, then the thread by primary key). */
export function inboxQuery(tx: Tx, agencyId: string, userId: string, q: { limit: number; cursor?: KeysetCursor }) {
  return tx
    .select({ ...threadColumns, atUs: keysetStamp(chatParticipants.lastMessageAt) })
    .from(chatParticipants)
    .innerJoin(chatThreads, memberJoin(agencyId, userId))
    .where(keysetAfterRaw(chatParticipants.lastMessageAt, chatParticipants.threadId, q.cursor, 'desc'))
    .orderBy(...keysetOrderRaw(chatParticipants.lastMessageAt, chatParticipants.threadId, 'desc'))
    .limit(q.limit + 1);
}

export async function inbox(
  tx: Tx,
  agencyId: string,
  userId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<(ThreadRow & { atUs: string })[]> {
  return inboxQuery(tx, agencyId, userId, q);
}

/** The agency's participants of a thread (≤ `max`, by primary key). */
export async function participantsOf(
  tx: Tx,
  agencyId: string,
  threadId: string,
  max: number,
): Promise<{ userId: string; lastReadAt: Date | null }[]> {
  return tx
    .select({ userId: chatParticipants.userId, lastReadAt: chatParticipants.lastReadAt })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.agencyId, agencyId), eq(chatParticipants.threadId, threadId)))
    .orderBy(chatParticipants.userId)
    .limit(max);
}

/**
 * The member joins the agency's copy of a thread (one statement): seeded with the thread's latest message time, unless
 * it already has `max` participants (or the member is in it already). True when the member was added.
 */
export async function joinThread(
  tx: Tx,
  agencyId: string,
  threadId: string,
  userId: string,
  max: number,
): Promise<boolean> {
  const result = await tx.execute(sql`
    insert into ${chatParticipants} (agency_id, thread_id, user_id, last_message_at)
    select t.agency_id, t.id, ${userId}::uuid, t.last_message_at from ${chatThreads} t
     where t.agency_id = ${agencyId} and t.id = ${threadId}
       and (select count(*) from ${chatParticipants} p where p.agency_id = ${agencyId} and p.thread_id = ${threadId}) < ${max}
    on conflict do nothing`);
  return (result.rowCount ?? 0) > 0;
}

/** A `DIRECT` thread (the insert guard stamps its starter and times). */
export async function insertDirectThread(
  tx: Tx,
  t: { agencyId: string; id: string; title: string | null },
): Promise<{ lastMessageAt: Date }> {
  const [row] = await tx
    .insert(chatThreads)
    .values({ agencyId: t.agencyId, id: t.id, kind: 'DIRECT', title: t.title })
    .returning({ lastMessageAt: chatThreads.lastMessageAt });
  return row as { lastMessageAt: Date };
}

/**
 * The agency's copy of a viewing request's thread (id = the request's), unless it exists already (the other agency
 * opened it first: its copy was appended by `chat_threads_mirror`). True when this call created it.
 */
export async function insertViewingThread(
  tx: Tx,
  t: { agencyId: string; id: string; peerAgencyId: string },
): Promise<boolean> {
  const rows = await tx
    .insert(chatThreads)
    .values({ agencyId: t.agencyId, id: t.id, kind: 'VIEWING', peerAgencyId: t.peerAgencyId })
    .onConflictDoNothing()
    .returning({ id: chatThreads.id });
  return rows.length > 0;
}

/**
 * S11-05: the agency's copy of its reply thread to a network post (`chat_threads_mirror` checks the post is an open one
 * of `peerAgencyId`, copies it to that agency with the post's title and seats the post's author), unless the agency
 * has one already (`chat_threads_network_uq`). The thread's id either way.
 */
export async function insertNetworkThread(
  tx: Tx,
  t: { agencyId: string; id: string; peerAgencyId: string; networkPostId: string },
): Promise<{ id: string; created: boolean }> {
  const rows = await tx
    .insert(chatThreads)
    .values({
      agencyId: t.agencyId,
      id: t.id,
      kind: 'NETWORK',
      peerAgencyId: t.peerAgencyId,
      networkPostId: t.networkPostId,
    })
    .onConflictDoNothing()
    .returning({ id: chatThreads.id });
  if (rows[0]) return { id: rows[0].id, created: true };
  const [existing] = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.agencyId, t.agencyId),
        eq(chatThreads.networkPostId, t.networkPostId),
        eq(chatThreads.peerAgencyId, t.peerAgencyId),
      ),
    );
  if (!existing) throw new Error('chat_threads: network thread neither inserted nor found');
  return { id: existing.id, created: false };
}

/** The thread's latest message time on the agency's copy (readable by any member: the thread row is STRICT). */
export async function threadLastMessageAt(tx: Tx, agencyId: string, threadId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: chatThreads.lastMessageAt })
    .from(chatThreads)
    .where(and(eq(chatThreads.agencyId, agencyId), eq(chatThreads.id, threadId)));
  return row?.at ?? null;
}

/** Participants of the agency's copy (existing ones are kept); `lastMessageAt` seeds their thread list's sort key. */
export async function insertParticipants(
  tx: Tx,
  agencyId: string,
  threadId: string,
  userIds: readonly string[],
  lastMessageAt: Date,
): Promise<number> {
  if (userIds.length === 0) return 0;
  const rows = await tx
    .insert(chatParticipants)
    .values(userIds.map((userId) => ({ agencyId, threadId, userId, lastMessageAt })))
    .onConflictDoNothing()
    .returning({ userId: chatParticipants.userId });
  return rows.length;
}

export interface MessageRow {
  id: string;
  threadId: string;
  senderAgencyId: string;
  senderUserId: string;
  senderName: string;
  body: string;
  createdAt: Date;
}

const messageColumns = {
  id: chatMessages.id,
  threadId: chatMessages.threadId,
  senderAgencyId: chatMessages.senderAgencyId,
  senderUserId: chatMessages.senderUserId,
  senderName: chatMessages.senderName,
  body: chatMessages.body,
  createdAt: chatMessages.createdAt,
};

/** The thread's messages on the agency's copy, newest first (`chat_messages_thread_created_idx`). */
export function listMessagesQuery(
  tx: Tx,
  agencyId: string,
  threadId: string,
  q: { limit: number; cursor?: KeysetCursor },
) {
  return tx
    .select({ ...messageColumns, atUs: keysetStamp(chatMessages.createdAt) })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.agencyId, agencyId),
        eq(chatMessages.threadId, threadId),
        keysetAfterRaw(chatMessages.createdAt, chatMessages.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(chatMessages.createdAt, chatMessages.id, 'desc'))
    .limit(q.limit + 1);
}

export async function listMessages(
  tx: Tx,
  agencyId: string,
  threadId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<(MessageRow & { atUs: string })[]> {
  return listMessagesQuery(tx, agencyId, threadId, q);
}

/**
 * A member's message (the guard stamps its time; `chat_messages_fanout` checks the sender takes part, appends the other
 * agency's copy and moves both threads). Null when the sender's `clientKey` was used already (a retried send).
 */
export async function insertMessage(
  tx: Tx,
  m: {
    agencyId: string;
    id: string;
    threadId: string;
    senderUserId: string;
    senderName: string;
    body: string;
    clientKey: string | null;
  },
): Promise<MessageRow | null> {
  const rows = await tx
    .insert(chatMessages)
    .values({
      agencyId: m.agencyId,
      id: m.id,
      threadId: m.threadId,
      senderAgencyId: m.agencyId,
      senderUserId: m.senderUserId,
      senderName: m.senderName,
      body: m.body,
      clientKey: m.clientKey,
    })
    .onConflictDoNothing()
    .returning(messageColumns);
  return rows[0] ?? null;
}

/** The sender's earlier message with this idempotency key (`chat_messages_client_key_uq`). */
export async function messageByClientKey(
  tx: Tx,
  agencyId: string,
  senderUserId: string,
  clientKey: string,
): Promise<MessageRow | null> {
  const [row] = await tx
    .select(messageColumns)
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.agencyId, agencyId),
        eq(chatMessages.senderUserId, senderUserId),
        eq(chatMessages.clientKey, clientKey),
      ),
    );
  return row ?? null;
}

/** Everything up to the thread's latest message read by the member (never moves back). Null: not a participant. */
export async function markRead(
  tx: Tx,
  agencyId: string,
  userId: string,
  threadId: string,
): Promise<{ lastReadAt: Date | null; previousReadAt: Date | null; changed: boolean } | null> {
  const result = await tx.execute<{
    last_read_at: Date | string | null;
    previous_read_at: Date | string | null;
    changed: boolean;
  }>(sql`
    with old as (
      select last_read_at from ${chatParticipants}
       where agency_id = ${agencyId} and thread_id = ${threadId} and user_id = ${userId}
    )
    update ${chatParticipants} p
       set last_read_at = greatest(coalesce(p.last_read_at, p.last_message_at), p.last_message_at)
      from old
     where p.agency_id = ${agencyId} and p.thread_id = ${threadId} and p.user_id = ${userId}
    returning p.last_read_at, old.last_read_at as previous_read_at,
              (old.last_read_at is distinct from p.last_read_at) as changed`);
  const row = result.rows[0];
  if (!row) return null;
  const date = (v: Date | string | null) => (v === null ? null : new Date(v));
  return { lastReadAt: date(row.last_read_at), previousReadAt: date(row.previous_read_at), changed: row.changed };
}

/* ------------------------------------------------------------------ worker side (app_system) */

/** One message from its sender agency's copy. */
export async function messageOf(tx: Tx, agencyId: string, id: string): Promise<MessageRow | null> {
  const [row] = await tx
    .select(messageColumns)
    .from(chatMessages)
    .where(and(eq(chatMessages.agencyId, agencyId), eq(chatMessages.id, id)));
  return row ?? null;
}

export interface FanoutParticipant {
  agencyId: string;
  userId: string;
  lastReadAt: Date | null;
  notifiedAt: Date | null;
}

/** Every agency's participants of a thread (`chat_participants_thread_idx`), ≤ 2 × `CHAT_LIMITS.participants`. */
export function participantsAcrossQuery(tx: Tx, threadId: string, max: number) {
  return tx
    .select({
      agencyId: chatParticipants.agencyId,
      userId: chatParticipants.userId,
      lastReadAt: chatParticipants.lastReadAt,
      notifiedAt: chatParticipants.notifiedAt,
    })
    .from(chatParticipants)
    .where(eq(chatParticipants.threadId, threadId))
    .limit(max);
}

export async function participantsAcross(tx: Tx, threadId: string, max: number): Promise<FanoutParticipant[]> {
  return participantsAcrossQuery(tx, threadId, max);
}

/** Recipients notified about the run of unread messages up to `at` (the next notification waits for a read). */
export async function markNotified(
  tx: Tx,
  agencyId: string,
  threadId: string,
  userIds: readonly string[],
  at: Date,
): Promise<void> {
  if (userIds.length === 0) return;
  await tx
    .update(chatParticipants)
    // never back: a retried older message's job does not undo a newer one's
    .set({
      notifiedAt: sql`greatest(coalesce(${chatParticipants.notifiedAt}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(chatParticipants.agencyId, agencyId),
        eq(chatParticipants.threadId, threadId),
        inArray(chatParticipants.userId, [...userIds]),
      ),
    );
}

/** Both agencies' copies of a thread (by primary key prefix of each agency: the thread id is shared). */
export async function threadCopies(
  tx: Tx,
  threadId: string,
  agencyIds: readonly string[],
): Promise<
  { agencyId: string; kind: string; peerAgencyId: string | null; subject: string | null; title: string | null }[]
> {
  if (agencyIds.length === 0) return [];
  return tx
    .select({
      agencyId: chatThreads.agencyId,
      kind: chatThreads.kind,
      peerAgencyId: chatThreads.peerAgencyId,
      subject: chatThreads.subject,
      title: chatThreads.title,
    })
    .from(chatThreads)
    .where(and(inArray(chatThreads.agencyId, [...agencyIds]), eq(chatThreads.id, threadId)));
}

/** The viewing thread's subject on both copies (the listing's reference). */
export async function setSubject(
  tx: Tx,
  threadId: string,
  agencyIds: readonly string[],
  subject: string,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({ subject, updatedAt: sql`now()` })
    .where(and(inArray(chatThreads.agencyId, [...agencyIds]), eq(chatThreads.id, threadId)));
}

/** A viewing thread's copies become read-only (its request was declined, cancelled or expired). */
export async function closeThread(tx: Tx, threadId: string, agencyIds: readonly string[]): Promise<number> {
  const rows = await tx
    .update(chatThreads)
    .set({ closedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        inArray(chatThreads.agencyId, [...agencyIds]),
        eq(chatThreads.id, threadId),
        eq(chatThreads.kind, 'VIEWING'),
        isNull(chatThreads.closedAt),
      ),
    )
    .returning({ agencyId: chatThreads.agencyId });
  return rows.length;
}
