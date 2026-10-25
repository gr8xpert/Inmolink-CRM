import {
  CHAT_LIMITS,
  type ChatMessageDto,
  type ChatMessagePage,
  type ChatThreadDetailDto,
  type ChatThreadDto,
  type ChatThreadKind,
  type ChatThreadPage,
  CreateDirectThreadBody,
  type ListChatMessagesQuery,
  type ListChatThreadsQuery,
  type MarkChatReadDto,
  OpenViewingThreadBody,
  SendChatMessageBody,
  type SendChatMessageDto,
  type SendChatMessageBody as SendChatMessageInput,
} from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { impersonatorOf } from '../../impersonation';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as identity from '../identity';
import * as mls from '../mls';
import * as notifications from '../notifications';
import { chatEvents } from './events';
import { handoffLinks } from './handoff';
import { assertCan, can } from './policy';
import * as repo from './repo';

const userIdOf = (ctx: Ctx): string => {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return ctx.actor.userId;
};

/**
 * chat use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Every read and write is the caller's own: a thread is found
 * through the caller's participant row (one join), so a thread they are not in answers `CHAT_THREAD_NOT_FOUND` like no
 * thread at all — and RLS shows its messages to its participants only. Delivery (sockets, notifications, the e-mail
 * digest) is the worker's, after commit (`delivery.ts`).
 */

/** A thread never read before: its notifications of this long ago are read with it (older ones were mailed long since). */
const NOTIFIED_LOOKBACK_MS = 30 * 86_400_000;

/** The dashboard path of a thread (the `CHAT_MESSAGE` notification's link). */
export const threadLink = (threadId: string) => `/chat/${threadId}`;

/**
 * Unread when a message came after what the member read — or, never read, after the thread started (a thread without
 * messages has `last_message_at` = its start).
 */
const isUnread = (r: repo.ThreadRow) => r.lastMessageAt.getTime() > (r.lastReadAt ?? r.createdAt).getTime();

interface ThreadLookups {
  names: Map<string, string>;
  /** Agencies listed now (VERIFIED) — looked up only when a `NETWORK` thread is shown. */
  listed: ReadonlySet<string>;
}

/**
 * Read-only: closed (a declined viewing request; a network post's close job), or — S12-F12 review — a `NETWORK` thread
 * whose agency or peer is no longer listed (the fan-out trigger refuses its messages), so the UI hides the composer.
 */
const isReadOnly = (r: repo.ThreadRow, readerAgencyId: string, l: ThreadLookups) =>
  r.closedAt !== null ||
  (r.kind === 'NETWORK' && !(l.listed.has(readerAgencyId) && r.peerAgencyId !== null && l.listed.has(r.peerAgencyId)));

function toThreadDto(r: repo.ThreadRow, l: ThreadLookups, readerAgencyId: string): ChatThreadDto {
  const names = l.names;
  return {
    id: r.id,
    kind: r.kind as ChatThreadKind,
    viewingRequestId: r.kind === 'VIEWING' ? r.id : null,
    networkPostId: r.networkPostId,
    peerAgency: r.peerAgencyId ? { id: r.peerAgencyId, name: names.get(r.peerAgencyId) ?? null } : null,
    title: r.title,
    subject: r.subject,
    lastMessageAt: r.lastMessageAt.toISOString(),
    lastReadAt: r.lastReadAt ? r.lastReadAt.toISOString() : null,
    unread: isUnread(r),
    closed: isReadOnly(r, readerAgencyId, l),
  };
}

/** A message as `readerAgencyId`'s members see it. */
export function toMessageDto(m: repo.MessageRow, readerAgencyId: string): ChatMessageDto {
  return {
    id: m.id,
    threadId: m.threadId,
    sender: {
      agencyId: m.senderAgencyId,
      userId: m.senderUserId,
      name: m.senderName,
      ownAgency: m.senderAgencyId === readerAgencyId,
    },
    body: m.body,
    createdAt: m.createdAt.toISOString(),
  };
}

/** The peers' names, and — when a `NETWORK` thread is among them — which of the agencies are listed (one more query). */
async function threadLookups(ctx: Ctx, rows: readonly repo.ThreadRow[]): Promise<ThreadLookups> {
  const network = rows.filter((r) => r.kind === 'NETWORK' && r.peerAgencyId !== null);
  const [names, listed] = await Promise.all([
    agencies.directoryNamesOf(
      ctx.tx,
      rows.flatMap((r) => (r.peerAgencyId ? [r.peerAgencyId] : [])),
    ),
    network.length === 0
      ? Promise.resolve(new Map<string, string>())
      : agencies.listedAgencyNamesOf(ctx.tx, [ctx.tenant.agencyId, ...network.map((r) => r.peerAgencyId as string)]),
  ]);
  return { names, listed: new Set(listed.keys()) };
}

async function memberThread(ctx: Ctx, threadId: string): Promise<repo.ThreadRow> {
  const t = await repo.threadForMember(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx), threadId);
  if (!t) throw new AppError('CHAT_THREAD_NOT_FOUND');
  return t;
}

/** `GET /v1/chat/threads/:id`: the thread, the caller's agency's participants and the handoff links (≤ 5 queries). */
export async function getThread(ctx: Ctx, threadId: string): Promise<ChatThreadDetailDto> {
  assertCan(ctx, 'chat.read');
  const t = await memberThread(ctx, threadId);
  const participants = await repo.participantsOf(ctx.tx, ctx.tenant.agencyId, threadId, CHAT_LIMITS.participants);
  const [names, peers] = await Promise.all([
    identity.memberNames(
      ctx,
      participants.map((p) => p.userId),
    ),
    threadLookups(ctx, [t]),
  ]);
  return {
    ...toThreadDto(t, peers, ctx.tenant.agencyId),
    participants: participants.map((p) => ({
      userId: p.userId,
      name: names.get(p.userId) ?? null,
      lastReadAt: p.lastReadAt ? p.lastReadAt.toISOString() : null,
    })),
    handoff: handoffLinks({ locale: ctx.locale, kind: t.kind, subject: t.subject, title: t.title }),
  };
}

/** `GET /v1/chat/threads`: the caller's threads, latest activity first, keyset (two queries; three with a `NETWORK` thread). */
export async function listThreads(ctx: Ctx, query: ListChatThreadsQuery): Promise<ChatThreadPage> {
  assertCan(ctx, 'chat.read');
  const rows = await repo.inbox(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx), {
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
  });
  const lookups = await threadLookups(ctx, rows.slice(0, query.limit));
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.lastMessageAt, id: r.id, atUs: r.atUs }),
    (r) => toThreadDto(r, lookups, ctx.tenant.agencyId),
  );
}

/** `GET /v1/chat/threads/:id/messages`: newest first, keyset (two queries: the membership, the page). */
export async function listMessages(ctx: Ctx, threadId: string, query: ListChatMessagesQuery): Promise<ChatMessagePage> {
  assertCan(ctx, 'chat.read');
  const t = await memberThread(ctx, threadId);
  // staff impersonating a member may see the member's threads, not the colleagues' private conversations
  if (t.kind === 'DIRECT' && impersonatorOf(ctx)) throw new AppError('FORBIDDEN', { reason: 'impersonation' });
  const rows = await repo.listMessages(ctx.tx, ctx.tenant.agencyId, threadId, {
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
  });
  const page = toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }),
    (r) => toMessageDto(r, ctx.tenant.agencyId),
  );
  // S12-F9: VIEWING / NETWORK messages talk about clients — staff impersonating a member leave an audit row.
  await compliance.auditImpersonatedRead(ctx, 'chat.clientData.read', 'messages', {
    count: page.items.length,
    parentId: threadId,
    filter: { kind: t.kind },
  });
  return page;
}

/**
 * `POST /v1/chat/threads`: a `DIRECT` thread with colleagues (active members of the caller's agency, at most
 * `CHAT_LIMITS.directMembers`). The participants guard lets only the starter add them, in this transaction.
 */
export async function createDirectThread(ctx: Ctx, raw: CreateDirectThreadBody): Promise<ChatThreadDetailDto> {
  assertCan(ctx, 'chat.write');
  const body = CreateDirectThreadBody.parse(raw);
  const me = userIdOf(ctx);
  const others = [...new Set(body.userIds)].filter((u) => u !== me);
  if (others.length === 0) throw new AppError('CHAT_PARTICIPANTS_INVALID', { reason: 'no_colleague' });
  const members = await identity.activeClientMembersAmong(ctx.tx, ctx.tenant.agencyId, others);
  if (others.some((u) => !members.has(u))) throw new AppError('CHAT_PARTICIPANTS_INVALID', { reason: 'not_members' });
  const id = newId();
  const { lastMessageAt } = await repo.insertDirectThread(ctx.tx, {
    agencyId: ctx.tenant.agencyId,
    id,
    title: body.title ?? null,
  });
  await repo.insertParticipants(ctx.tx, ctx.tenant.agencyId, id, [me, ...others], lastMessageAt);
  return getThread(ctx, id);
}

/**
 * `POST /v1/chat/viewing-threads`: the thread of a viewing request the caller's agency is party to (introducer or
 * owner; `mls.viewings.read`), opened by whichever side comes first — the other side's copy is appended in the same
 * statement (`chat_threads_mirror`) and the worker seats both sides' default members (`chat.seatViewingThread`). The
 * caller joins it (any member who may read the agency's viewing requests). A declined, cancelled or expired request
 * opens no new thread; an existing one is joined read-only. Never anything of the client: the subject is the listing's
 * reference. ≤ 8 statements.
 */
export async function openViewingThread(ctx: Ctx, raw: OpenViewingThreadBody): Promise<ChatThreadDetailDto> {
  assertCan(ctx, 'chat.write');
  const body = OpenViewingThreadBody.parse(raw);
  const viewing = await mls.viewingCounterpart(ctx, body.viewingRequestId);
  const agencyId = ctx.tenant.agencyId;
  const closed = mls.CLOSED_VIEWING_STATUSES.has(viewing.status);
  if (!closed) {
    const created = await repo.insertViewingThread(ctx.tx, {
      agencyId,
      id: viewing.id,
      peerAgencyId: viewing.counterpartAgencyId,
    });
    if (created) await emit(ctx.tx, chatEvents.viewingThreadOpened({ threadId: viewing.id }));
  }
  await repo.joinThread(ctx.tx, agencyId, viewing.id, userIdOf(ctx), CHAT_LIMITS.participants);
  try {
    return await getThread(ctx, viewing.id);
  } catch (err) {
    // not joined: no thread to join (a closed request never opened one), or the agency's side is full
    if (err instanceof AppError && err.code === 'CHAT_THREAD_NOT_FOUND') {
      throw closed
        ? new AppError('VIEWING_REQUEST_STATE', { reason: 'closed' })
        : new AppError('CHAT_PARTICIPANTS_INVALID', { reason: 'full' });
    }
    throw err;
  }
}

/**
 * S11-05, for the network module's reply to a board post (`network.replyToPost`, which checked the post is an open one
 * of `posterAgencyId` the caller may read, not its own): the caller's agency's `NETWORK` thread with the post's agency —
 * created with the other agency's copy and the post's author seated (`chat_threads_mirror`), or the existing one,
 * which the caller joins — then the caller's message in it. ≤ 10 statements.
 */
export async function replyInNetworkThread(
  ctx: Ctx,
  input: { postId: string; posterAgencyId: string; message: SendChatMessageInput },
): Promise<{ thread: ChatThreadDetailDto } & SendChatMessageDto> {
  assertCan(ctx, 'chat.write');
  if (input.posterAgencyId === ctx.tenant.agencyId) throw new AppError('VALIDATION_FAILED', { reason: 'own_post' });
  const me = userIdOf(ctx);
  const agencyId = ctx.tenant.agencyId;
  const { id } = await repo.insertNetworkThread(ctx.tx, {
    agencyId,
    id: newId(),
    peerAgencyId: input.posterAgencyId,
    networkPostId: input.postId,
  });
  await repo.joinThread(ctx.tx, agencyId, id, me, CHAT_LIMITS.participants);
  const sent = await sendMessage(ctx, id, input.message);
  return { thread: await getThread(ctx, id), ...sent };
}

/**
 * S11-05, for the network module (`network.joinReplyThread`, which checked the caller may): the caller joins their
 * agency's copy of a `NETWORK` thread — e.g. an admin of the post's agency joins a reply thread its author was seated
 * on. Another kind, or none: `CHAT_THREAD_NOT_FOUND`. ≤ 7 statements.
 */
export async function joinNetworkThread(ctx: Ctx, threadId: string): Promise<ChatThreadDetailDto> {
  assertCan(ctx, 'chat.write');
  const agencyId = ctx.tenant.agencyId;
  const [copy] = await repo.threadCopies(ctx.tx, threadId, [agencyId]);
  if (!copy || copy.kind !== 'NETWORK') throw new AppError('CHAT_THREAD_NOT_FOUND');
  await repo.joinThread(ctx.tx, agencyId, threadId, userIdOf(ctx), CHAT_LIMITS.participants);
  try {
    return await getThread(ctx, threadId);
  } catch (err) {
    // not joined: the agency's side is full
    if (err instanceof AppError && err.code === 'CHAT_THREAD_NOT_FOUND') {
      throw new AppError('CHAT_PARTICIPANTS_INVALID', { reason: 'full' });
    }
    throw err;
  }
}

/** The Postgres SQLSTATE of a driver error (or the one Drizzle wraps in `cause`). */
function pgCodeOf(err: unknown): string | undefined {
  for (
    let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0;
    e && i < 3;
    e = e.cause as typeof e, i++
  ) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  }
  return undefined;
}

/**
 * `POST /v1/chat/threads/:id/messages`: a message from a participant (4 statements: membership, name, insert, event);
 * a closed viewing or network thread is read-only (`CHAT_THREAD_CLOSED`; the fan-out trigger refuses it too, and a
 * `NETWORK` thread's message once its post closed or either agency is no longer listed — S12-F12).
 * `clientKey` replays a retried send. The other agency's copy is appended in the same statement; the event drives
 * delivery to every participant's sockets and the `CHAT_MESSAGE` notification (→ e-mail digest after 5 minutes).
 */
export async function sendMessage(ctx: Ctx, threadId: string, raw: SendChatMessageBody): Promise<SendChatMessageDto> {
  assertCan(ctx, 'chat.write');
  const body = SendChatMessageBody.parse(raw);
  const me = userIdOf(ctx);
  const agencyId = ctx.tenant.agencyId;
  const thread = await memberThread(ctx, threadId);
  if (body.clientKey) {
    const prior = await repo.messageByClientKey(ctx.tx, agencyId, me, body.clientKey);
    if (prior) {
      if (prior.threadId !== threadId) throw new AppError('VALIDATION_FAILED', { field: 'clientKey' });
      return { message: toMessageDto(prior, agencyId), replayed: true };
    }
  }
  if (thread.closedAt) throw new AppError('CHAT_THREAD_CLOSED');
  const name = ((await identity.memberNames(ctx, [me])).get(me) ?? '').slice(0, 200);
  const inserted = await repo
    .insertMessage(ctx.tx, {
      agencyId,
      id: newId(),
      threadId,
      senderUserId: me,
      senderName: name,
      body: body.body,
      clientKey: body.clientKey ?? null,
    })
    .catch((err: unknown) => {
      // S12-F12: the fan-out trigger refuses a NETWORK thread whose post closed or whose agencies are no longer listed
      // (before the worker marks it closed): read-only, like a closed thread
      if (thread.kind === 'NETWORK' && pgCodeOf(err) === '42501') throw new AppError('CHAT_THREAD_CLOSED');
      throw err;
    });
  if (!inserted) {
    // the same key, sent twice at once: the other request's message
    const prior = body.clientKey ? await repo.messageByClientKey(ctx.tx, agencyId, me, body.clientKey) : null;
    if (!prior || prior.threadId !== threadId) throw new AppError('VALIDATION_FAILED', { field: 'clientKey' });
    return { message: toMessageDto(prior, agencyId), replayed: true };
  }
  await emit(ctx.tx, chatEvents.messageSent({ threadId, messageId: inserted.id, at: inserted.createdAt.getTime() }));
  return { message: toMessageDto(inserted, agencyId), replayed: false };
}

/**
 * `POST /v1/chat/threads/:id/read`: the caller read the thread up to its latest message. Its `CHAT_MESSAGE`
 * notifications are read too (seen: the digest leaves them out), and the read receipt goes to the participants.
 */
export async function markThreadRead(ctx: Ctx, threadId: string): Promise<MarkChatReadDto> {
  assertCan(ctx, 'chat.write');
  const me = userIdOf(ctx);
  const r = await repo.markRead(ctx.tx, ctx.tenant.agencyId, me, threadId);
  if (!r) throw new AppError('CHAT_THREAD_NOT_FOUND');
  if (r.changed && r.lastReadAt) {
    await emit(ctx.tx, chatEvents.threadRead({ threadId, userId: me, at: r.lastReadAt.getTime() }));
    // the notifications raised since the previous read (a second of slack: they carry the outbox event's time)
    const since = new Date((r.previousReadAt ?? new Date(Date.now() - NOTIFIED_LOOKBACK_MS)).getTime() - 1_000);
    await notifications.markLinkRead(ctx, { type: 'CHAT_MESSAGE', link: threadLink(threadId), since });
  }
  return { threadId, lastReadAt: r.lastReadAt ? r.lastReadAt.toISOString() : null };
}

/**
 * apps/realtime `/chat` `join`: whether the caller takes part in the thread (one query). A socket joins a thread's room
 * (typing indicator) only when this says so.
 */
export async function canJoinThread(ctx: Ctx, threadId: string): Promise<boolean> {
  if (!can(ctx, 'chat.read')) return false;
  return (await repo.threadForMember(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx), threadId)) !== null;
}
