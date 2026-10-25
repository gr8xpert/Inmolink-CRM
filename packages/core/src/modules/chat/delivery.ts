import {
  CHAT_LIMITS,
  type ChatMessagePush,
  type ChatReadPush,
  REALTIME_CHAT_EVENTS,
  REALTIME_CHAT_NAMESPACE,
} from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { publishUserEvents, type UserEvent } from '@inmolink/platform/cache';
import type { EventMeta } from '@inmolink/platform/outbox';
import * as identity from '../identity';
import * as mls from '../mls';
import * as notifications from '../notifications';
import * as repo from './repo';
import { threadLink, toMessageDto } from './service';

/**
 * chat worker side (app_system, PATTERNS §12): delivery after commit. Every function reads in its own short `withSystem`
 * transaction and publishes outside it (redis-cache pub/sub → apps/realtime `/chat`, each recipient's own room).
 * At least once: a retried job publishes again; clients drop message ids they have.
 */

type Publish = (events: readonly UserEvent[]) => Promise<void>;

/**
 * Every participant of the thread's copies at `agencyId` and its peer (never a third agency's rows) who is still an
 * active member of their agency (S12-F10: a deactivated member gets no push, no notification).
 */
async function seated(tx: Tx, agencyId: string, threadId: string) {
  const [own] = await repo.threadCopies(tx, threadId, [agencyId]);
  if (!own) return null;
  const agencyIds = new Set([agencyId, ...(own.peerAgencyId ? [own.peerAgencyId] : [])]);
  const seatedRows = (await repo.participantsAcross(tx, threadId, 2 * CHAT_LIMITS.participants)).filter((p) =>
    agencyIds.has(p.agencyId),
  );
  const active = await identity.activeMembersAcross(tx, seatedRows);
  const participants = seatedRows.filter((p) => active.has(`${p.agencyId}:${p.userId}`));
  return { thread: own, participants };
}

/**
 * `chat.deliverMessage` (one per `chat.message.sent`): one load of the message and of every participant (both
 * agencies), then (1) the message to each participant's sockets (the sender's other tabs too), as their agency sees
 * it — one pipeline, first, for latency — and (2) a `CHAT_MESSAGE` notification for each participant (but the sender)
 * who had read everything before this message and was not told since their last read: one notification per run of
 * unread messages, not one per message. The notifications module does the rest: the recipient's preference, the live
 * badge and the e-mail digest of what is still unread after 5 minutes (reading the thread marks it read). Per agency:
 * `raiseNotifications` with `sourceKey` = event + agency, so a retried job pushes again (clients drop known ids) but
 * raises nothing twice.
 */
export async function deliverMessage(
  p: { agencyId: string; threadId: string; messageId: string },
  meta: Pick<EventMeta, 'eventId' | 'createdAt'>,
  publish: Publish = publishUserEvents,
): Promise<{ pushed: number; notified: number }> {
  const loaded = await withSystem('chat.deliverMessage', async (tx) => {
    const message = await repo.messageOf(tx, p.agencyId, p.messageId);
    if (!message || message.threadId !== p.threadId) return null;
    const seats = await seated(tx, p.agencyId, p.threadId);
    return seats ? { message, ...seats } : null;
  });
  if (!loaded) return { pushed: 0, notified: 0 };
  const { message } = loaded;
  const events: UserEvent[] = loaded.participants.map((r) => {
    const data: ChatMessagePush = { agencyId: r.agencyId, message: toMessageDto(message, r.agencyId) };
    return {
      userId: r.userId,
      agencyId: r.agencyId,
      namespace: REALTIME_CHAT_NAMESPACE,
      event: REALTIME_CHAT_EVENTS.message,
      data,
    };
  });
  if (events.length > 0) await publish(events);

  const at = message.createdAt.getTime();
  const byAgency = new Map<string, string[]>();
  for (const r of loaded.participants) {
    if (r.agencyId === message.senderAgencyId && r.userId === message.senderUserId) continue;
    const read = r.lastReadAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (read >= at) continue;
    // told already about an earlier unread message (and not read since): this one joins that notification
    if (r.notifiedAt && r.notifiedAt.getTime() > read && r.notifiedAt.getTime() < at) continue;
    byAgency.set(r.agencyId, [...(byAgency.get(r.agencyId) ?? []), r.userId]);
  }
  if (byAgency.size === 0) return { pushed: events.length, notified: 0 };
  const subject = loaded.thread.subject ?? loaded.thread.title ?? '';
  const notified = await withSystem(`chat.deliverMessage notify: thread ${p.threadId}`, async (tx) => {
    let n = 0;
    for (const [agencyId, userIds] of byAgency) {
      const res = await notifications.raiseNotifications(tx, {
        agencyId,
        type: 'CHAT_MESSAGE',
        userIds,
        params: { actor: message.senderName.slice(0, 200), subject: subject.slice(0, 200) },
        link: threadLink(p.threadId),
        sourceKey: `${meta.eventId}:${agencyId}`,
        at: meta.createdAt,
        actorUserId: agencyId === message.senderAgencyId ? message.senderUserId : null,
      });
      await repo.markNotified(tx, agencyId, p.threadId, userIds, message.createdAt);
      n += res.notified.length;
    }
    return n;
  });
  return { pushed: events.length, notified };
}

/** `chat.pushRead` (one per `chat.thread.read`): the read receipt to every participant's sockets, both agencies. */
export async function pushRead(
  p: { agencyId: string; threadId: string; userId: string; at: number },
  publish: Publish = publishUserEvents,
): Promise<{ pushed: number }> {
  const seats = await withSystem('chat.pushRead', (tx) => seated(tx, p.agencyId, p.threadId));
  if (!seats) return { pushed: 0 };
  const lastReadAt = new Date(p.at).toISOString();
  const events: UserEvent[] = seats.participants.map((r) => {
    const data: ChatReadPush = {
      agencyId: r.agencyId,
      threadId: p.threadId,
      reader: { agencyId: p.agencyId, userId: p.userId },
      lastReadAt,
    };
    return {
      userId: r.userId,
      agencyId: r.agencyId,
      namespace: REALTIME_CHAT_NAMESPACE,
      event: REALTIME_CHAT_EVENTS.read,
      data,
    };
  });
  if (events.length > 0) await publish(events);
  return { pushed: events.length };
}

/**
 * `chat.seatViewingThread` (one per `chat.viewingThread.opened`): both copies of a viewing request's thread get their
 * side's default members (the member who asked; the listing's agent; else the admins — like the viewing's
 * notifications) and the listing's reference as subject. Idempotent (existing participants are kept). The event's
 * agency must be a party to the request (RLS-checked when it was written).
 */
export async function seatViewingThread(p: { agencyId: string; threadId: string }): Promise<{ seated: number }> {
  return withSystem(`chat.seatViewingThread: ${p.threadId}`, async (tx) => {
    const v = await mls.viewingChatContext(tx, p.threadId);
    if (!v || (p.agencyId !== v.introducerAgencyId && p.agencyId !== v.ownerAgencyId)) return { seated: 0 };
    const sides = [
      { agencyId: v.introducerAgencyId, userIds: v.introducerUserIds },
      { agencyId: v.ownerAgencyId, userIds: v.ownerUserIds },
    ];
    const copies = await repo.threadCopies(
      tx,
      p.threadId,
      sides.map((s) => s.agencyId),
    );
    let seatedCount = 0;
    for (const side of sides) {
      if (!copies.some((c) => c.agencyId === side.agencyId && c.kind === 'VIEWING')) continue;
      const at = (await repo.threadLastMessageAt(tx, side.agencyId, p.threadId)) ?? new Date();
      seatedCount += await repo.insertParticipants(tx, side.agencyId, p.threadId, side.userIds, at);
    }
    if (v.subject && copies.length > 0) {
      await repo.setSubject(
        tx,
        p.threadId,
        copies.map((c) => c.agencyId),
        v.subject.slice(0, 120),
      );
    }
    return { seated: seatedCount };
  });
}

/**
 * `chat.closeViewingThread` (one per `mls.viewing.changed` that declines, cancels or expires a request): both copies of
 * its thread become read-only. Re-reads the request (an out-of-order event closes nothing still open). The event's
 * agency must be a party to the request (RLS-checked when it was written).
 */
export async function closeViewingThread(p: { agencyId: string; requestId: string }): Promise<{ closed: number }> {
  return withSystem(`chat.closeViewingThread: ${p.requestId}`, async (tx) => {
    const v = await mls.viewingChatContext(tx, p.requestId);
    if (!v || (p.agencyId !== v.introducerAgencyId && p.agencyId !== v.ownerAgencyId)) return { closed: 0 };
    if (!mls.CLOSED_VIEWING_STATUSES.has(v.status)) return { closed: 0 };
    return { closed: await repo.closeThread(tx, p.requestId, [v.introducerAgencyId, v.ownerAgencyId]) };
  });
}
