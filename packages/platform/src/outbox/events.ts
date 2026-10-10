import type { z } from 'zod';

/** Event types are dotted lower-camel segments: `<module>.<entity>.<change>`. */
const EVENT_TYPE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,4}$/;

/** A validated event ready for `emit()`. */
export interface OutboxMessage<T = unknown> {
  readonly type: string;
  readonly version: number;
  readonly payload: T;
}

/** Callable event definition: `listingEvents.updated({ … })` validates and builds a message. */
export interface EventDef<S extends z.ZodType = z.ZodType> {
  (payload: z.input<S>): OutboxMessage<z.output<S>>;
  readonly type: string;
  readonly version: number;
  readonly schema: S;
}

export type EventPayload<E extends EventDef> = z.output<E['schema']>;

/** Delivery metadata passed to subscribers next to the payload. */
export interface EventMeta {
  eventId: string;
  /** The row's agency (RLS-checked at emit). Use this — not a payload field — as the tenant / fair-share group. */
  agencyId: string;
  type: string;
  version: number;
  createdAt: Date;
  /** 1 on first delivery. */
  attempt: number;
}

export type EventHandler<E extends EventDef = EventDef> = (
  payload: EventPayload<E>,
  meta: EventMeta,
) => Promise<unknown> | unknown;

export interface Subscriber {
  name: string;
  def: EventDef;
  handler: EventHandler;
}

const key = (type: string, version: number) => `${type}@${version}`;

/**
 * Defines a versioned event (PATTERNS §8). A breaking payload change is a new version; keep
 * the old definition until no row of it is pending, so the dispatcher can still parse it.
 */
export function defineEvent<S extends z.ZodType>(type: string, version: number, schema: S): EventDef<S> {
  if (!EVENT_TYPE.test(type)) throw new TypeError(`defineEvent: invalid event type ${JSON.stringify(type)}`);
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`defineEvent: version must be a positive integer`);
  const build = (payload: z.input<S>): OutboxMessage<z.output<S>> => ({
    type,
    version,
    payload: schema.parse(payload),
  });
  return Object.assign(build, { type, version, schema });
}

/** Subscriber lists per `type@version`. The process-wide default is used by `subscribe()`. */
export class SubscriberRegistry {
  private readonly byKey = new Map<string, Subscriber[]>();

  add<E extends EventDef>(def: E, handler: EventHandler<E>, name?: string): () => void {
    const k = key(def.type, def.version);
    const list = this.byKey.get(k) ?? [];
    const sub: Subscriber = { def, handler: handler as EventHandler, name: name ?? `${k}#${list.length + 1}` };
    list.push(sub);
    this.byKey.set(k, list);
    return () => {
      const current = this.byKey.get(k) ?? [];
      this.byKey.set(
        k,
        current.filter((s) => s !== sub),
      );
    };
  }

  get(type: string, version: number): readonly Subscriber[] {
    return this.byKey.get(key(type, version)) ?? [];
  }

  clear(): void {
    this.byKey.clear();
  }
}

export const defaultSubscribers = new SubscriberRegistry();

/**
 * Reacts to an event from another module (PATTERNS §8). Handlers run in the dispatcher, outside any
 * transaction, at least once per event: keep them fast (enqueue a job) and idempotent (stable job IDs,
 * ignore stale versions). Returns an unsubscribe function.
 */
export function subscribe<E extends EventDef>(
  def: E,
  handler: EventHandler<E>,
  options: { name?: string } = {},
): () => void {
  return defaultSubscribers.add(def, handler, options.name);
}
