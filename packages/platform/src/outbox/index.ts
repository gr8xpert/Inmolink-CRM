/**
 * @inmolink/platform/outbox — transactional outbox (PLAN §5.3 #6, PATTERNS §8).
 *
 *   events.ts  — `defineEvent` in the module's events.ts, `subscribe` in the consumer module
 *   service    — `await emit(ctx.tx, listingEvents.updated({ … }))` in the business transaction
 *   worker     — `createDispatcher({ runSystem: withSystem, listen: (cb) => listen(OUTBOX_CHANNEL, cb), logger })`
 */
export {
  createDispatcher,
  type Dispatcher,
  type DispatcherOptions,
  type DispatchStats,
  type ListenFn,
  type RunSystem,
} from './dispatcher';
export {
  type EmitOptions,
  emit,
  MAX_EVENT_PAYLOAD_BYTES,
  OUTBOX_CHANNEL,
  PLATFORM_AGENCY_ID,
  type SqlExecutor,
} from './emit';
export {
  defaultSubscribers,
  defineEvent,
  type EventDef,
  type EventHandler,
  type EventMeta,
  type EventPayload,
  isDeclaredEvent,
  type OutboxMessage,
  type Subscriber,
  SubscriberRegistry,
  subscribe,
} from './events';
export { countReplayable, type ReplayBatch, type ReplayFilter, replayOutboxBatch } from './replay';
