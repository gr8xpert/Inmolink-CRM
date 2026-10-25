import { metrics } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import type { Logger } from '../logger';

/**
 * Per-user realtime events over redis-cache pub/sub (S11-04): a worker publishes "this member has a new
 * notification"; every apps/realtime node subscribes and emits it to its own sockets in that member's room. Pub/sub
 * writes no keys, so allkeys-lru eviction cannot touch it. At most once per node (a node that is down misses it; the
 * client re-reads its feed on reconnect), so the payload is a hint the client may also fetch, never the only copy.
 */
export const USER_EVENTS_CHANNEL = 'inl:rt:user-events';

/** Events are small (one DTO): a publish above this is a bug, refused before it reaches Redis. */
export const MAX_USER_EVENT_BYTES = 16_384;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-zA-Z0-9.]{0,63}$/;
const NAMESPACE = /^\/[a-z][a-z0-9-]{0,31}$/;

/**
 * S12-F4: every message starts with its recipient, `agencyId:userId|` (two UUIDs, 74 characters), then the JSON. Every
 * node receives every message: a node with no socket of that member skips it on the prefix alone — no JSON parse, no
 * checks.
 */
const UUID_LENGTH = 36;
const PREFIX_LENGTH = 2 * UUID_LENGTH + 2;

export interface UserEvent {
  /** The recipient: only sockets authenticated as this user, in this agency (token `agency` claim), receive it. */
  userId: string;
  agencyId: string;
  /** Socket.io namespace, e.g. `/notifications`. */
  namespace: string;
  /** Socket.io event name, e.g. `notification`. */
  event: string;
  data: unknown;
}

/** `prefix: false` writes the previous release's form (bare JSON) while realtime nodes of that release still run. */
export function encodeUserEvent(e: UserEvent, options: { prefix?: boolean } = {}): string {
  if (!UUID.test(e.userId)) throw new TypeError('user event: userId must be a UUID');
  if (!UUID.test(e.agencyId)) throw new TypeError('user event: agencyId must be a UUID');
  if (!NAMESPACE.test(e.namespace)) throw new TypeError('user event: invalid namespace');
  if (!NAME.test(e.event)) throw new TypeError('user event: invalid event name');
  const json = JSON.stringify(e);
  const text = options.prefix === false ? json : `${e.agencyId}:${e.userId}|${json}`;
  if (Buffer.byteLength(text) > MAX_USER_EVENT_BYTES) throw new TypeError('user event: payload too large');
  return text;
}

/**
 * S12-F4: the recipient named by a message's prefix (not validated: a match against a local room is the check), or
 * null when the message has none (a publisher of the previous release during a deploy).
 */
export function userEventRecipient(text: string): { agencyId: string; userId: string } | null {
  if (
    text.length < PREFIX_LENGTH ||
    text.charCodeAt(UUID_LENGTH) !== 58 ||
    text.charCodeAt(PREFIX_LENGTH - 1) !== 124
  ) {
    return null; // ':' and '|'
  }
  return { agencyId: text.slice(0, UUID_LENGTH), userId: text.slice(UUID_LENGTH + 1, PREFIX_LENGTH - 1) };
}

/** Parses one channel message; null for anything malformed (logged by the caller, never thrown into ioredis). */
export function decodeUserEvent(text: string): UserEvent | null {
  if (Buffer.byteLength(text) > MAX_USER_EVENT_BYTES) return null;
  const recipient = userEventRecipient(text);
  try {
    const v = JSON.parse(recipient ? text.slice(PREFIX_LENGTH) : text) as Partial<UserEvent>;
    if (typeof v.userId !== 'string' || !UUID.test(v.userId)) return null;
    if (typeof v.agencyId !== 'string' || !UUID.test(v.agencyId)) return null;
    if (typeof v.namespace !== 'string' || !NAMESPACE.test(v.namespace)) return null;
    if (typeof v.event !== 'string' || !NAME.test(v.event)) return null;
    // the prefix routed it: it must name the same member as the event
    if (recipient && (recipient.agencyId !== v.agencyId || recipient.userId !== v.userId)) return null;
    return { userId: v.userId, agencyId: v.agencyId, namespace: v.namespace, event: v.event, data: v.data };
  } catch {
    return null;
  }
}

const meter = metrics.getMeter('@inmolink/platform');
/** S12-F4: per node, what became of each message: `delivered` (handed on), `skipped` (no local socket), `dropped`. */
const userEventsCounter = meter.createCounter('inmolink.realtime.user_events', {
  description: 'Per-user realtime events received by a node, by outcome (delivered, skipped, dropped)',
});
/**
 * S12-F4: the subscriber connection closed after it was up (Redis drops a subscriber over its
 * `client-output-buffer-limit pubsub`, or the network failed): messages published until it resubscribes are lost on
 * this node. Failed reconnect attempts are not counted again. Alert on any.
 */
const subscriberDisconnects = meter.createCounter('inmolink.realtime.subscriber_disconnects', {
  description: 'Times a realtime node lost its user-events subscription',
});

export interface SubscribeUserEventsOptions {
  /**
   * S12-F4: whether this node has a socket of that member (its rooms). A message whose prefix names a member with no
   * local socket is skipped before parsing. Omit to take every message.
   */
  isLocal?: (agencyId: string, userId: string) => boolean;
}

/**
 * Subscribes `sub` (a dedicated subscriber connection) to the channel; `handler` gets each well-formed event for a
 * member with a socket on this node. Returns the unsubscribe step for shutdown.
 */
export async function subscribeUserEvents(
  sub: Redis,
  handler: (e: UserEvent) => void,
  logger: Logger,
  options: SubscribeUserEventsOptions = {},
): Promise<() => Promise<void>> {
  const { isLocal } = options;
  const onMessage = (channel: string, message: string) => {
    if (channel !== USER_EVENTS_CHANNEL) return;
    if (isLocal) {
      const recipient = userEventRecipient(message);
      if (recipient && !isLocal(recipient.agencyId, recipient.userId)) {
        userEventsCounter.add(1, { outcome: 'skipped' });
        return;
      }
    }
    const event = decodeUserEvent(message);
    if (!event) {
      userEventsCounter.add(1, { outcome: 'dropped' });
      logger.warn({ channel }, 'malformed user event dropped');
      return;
    }
    userEventsCounter.add(1, { outcome: 'delivered' });
    try {
      handler(event);
    } catch (err) {
      logger.error({ err }, 'user event handler failed');
    }
  };
  // ioredis resubscribes on reconnect (`autoResubscribe`); what was published in between is lost. Counted once per
  // connection that was up: a reconnect attempt that fails closes again without a `ready` in between.
  let up = true; // subscribing below succeeds only on a live connection
  const onReady = () => {
    up = true;
  };
  const onClose = () => {
    if (!up) return;
    up = false;
    subscriberDisconnects.add(1);
    logger.warn({ channel: USER_EVENTS_CHANNEL }, 'user events subscriber disconnected');
  };
  sub.on('message', onMessage);
  sub.on('ready', onReady);
  sub.on('close', onClose);
  await sub.subscribe(USER_EVENTS_CHANNEL);
  return async () => {
    sub.off('message', onMessage);
    sub.off('ready', onReady);
    sub.off('close', onClose);
    await sub.unsubscribe(USER_EVENTS_CHANNEL).catch(() => undefined);
  };
}
