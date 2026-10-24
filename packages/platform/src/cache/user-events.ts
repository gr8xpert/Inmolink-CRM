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

export function encodeUserEvent(e: UserEvent): string {
  if (!UUID.test(e.userId)) throw new TypeError('user event: userId must be a UUID');
  if (!UUID.test(e.agencyId)) throw new TypeError('user event: agencyId must be a UUID');
  if (!NAMESPACE.test(e.namespace)) throw new TypeError('user event: invalid namespace');
  if (!NAME.test(e.event)) throw new TypeError('user event: invalid event name');
  const text = JSON.stringify(e);
  if (Buffer.byteLength(text) > MAX_USER_EVENT_BYTES) throw new TypeError('user event: payload too large');
  return text;
}

/** Parses one channel message; null for anything malformed (logged by the caller, never thrown into ioredis). */
export function decodeUserEvent(text: string): UserEvent | null {
  if (Buffer.byteLength(text) > MAX_USER_EVENT_BYTES) return null;
  try {
    const v = JSON.parse(text) as Partial<UserEvent>;
    if (typeof v.userId !== 'string' || !UUID.test(v.userId)) return null;
    if (typeof v.agencyId !== 'string' || !UUID.test(v.agencyId)) return null;
    if (typeof v.namespace !== 'string' || !NAMESPACE.test(v.namespace)) return null;
    if (typeof v.event !== 'string' || !NAME.test(v.event)) return null;
    return { userId: v.userId, agencyId: v.agencyId, namespace: v.namespace, event: v.event, data: v.data };
  } catch {
    return null;
  }
}

/**
 * Subscribes `sub` (a dedicated subscriber connection) to the channel; `handler` gets each well-formed event.
 * Returns the unsubscribe step for shutdown.
 */
export async function subscribeUserEvents(
  sub: Redis,
  handler: (e: UserEvent) => void,
  logger: Logger,
): Promise<() => Promise<void>> {
  const onMessage = (channel: string, message: string) => {
    if (channel !== USER_EVENTS_CHANNEL) return;
    const event = decodeUserEvent(message);
    if (!event) {
      logger.warn({ channel }, 'malformed user event dropped');
      return;
    }
    try {
      handler(event);
    } catch (err) {
      logger.error({ err }, 'user event handler failed');
    }
  };
  sub.on('message', onMessage);
  await sub.subscribe(USER_EVENTS_CHANNEL);
  return async () => {
    sub.off('message', onMessage);
    await sub.unsubscribe(USER_EVENTS_CHANNEL).catch(() => undefined);
  };
}
