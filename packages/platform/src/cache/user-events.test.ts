import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger';
import {
  decodeUserEvent,
  encodeUserEvent,
  MAX_USER_EVENT_BYTES,
  subscribeUserEvents,
  USER_EVENTS_CHANNEL,
  type UserEvent,
  userEventRecipient,
} from './user-events';

const USER = '0192a0b4-0000-7000-8000-000000000001';
const OTHER = '0192a0b4-0000-7000-8000-000000000002';
const AGENCY = '0192a0b4-0000-7000-8000-0000000000a1';

describe('user events (S11-04)', () => {
  it('[S11-04] round-trips a per-user event and refuses malformed ones', () => {
    const e = { userId: USER, agencyId: USER, namespace: '/notifications', event: 'notification', data: { id: USER } };
    expect(decodeUserEvent(encodeUserEvent(e))).toEqual(e);
    expect(() => encodeUserEvent({ ...e, userId: 'everyone' })).toThrow('userId');
    expect(() => encodeUserEvent({ ...e, namespace: 'notifications' })).toThrow('namespace');
    expect(() => encodeUserEvent({ ...e, data: 'x'.repeat(MAX_USER_EVENT_BYTES) })).toThrow('too large');
    expect(decodeUserEvent('not json')).toBeNull();
    expect(decodeUserEvent(JSON.stringify({ ...e, userId: '*' }))).toBeNull();
    expect(decodeUserEvent(JSON.stringify({ ...e, agencyId: undefined }))).toBeNull();
    expect(decodeUserEvent(JSON.stringify({ ...e, namespace: '/../x' }))).toBeNull();
    expect(decodeUserEvent(JSON.stringify({ ...e, data: 'x'.repeat(MAX_USER_EVENT_BYTES) }))).toBeNull();
  });
});

/** A stand-in subscriber connection: `emit('message', channel, text)` is what ioredis does. */
function fakeSubscriber() {
  const sub = new EventEmitter() as EventEmitter & Partial<Redis>;
  sub.subscribe = vi.fn(async () => 1) as unknown as Redis['subscribe'];
  sub.unsubscribe = vi.fn(async () => 0) as unknown as Redis['unsubscribe'];
  return sub as unknown as Redis & EventEmitter;
}

const event = (userId: string): UserEvent => ({
  userId,
  agencyId: AGENCY,
  namespace: '/notifications',
  event: 'notification',
  data: { n: 1 },
});

describe('user events routing (S12-F4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('[S12-F4] messages carry their recipient as an agencyId:userId| prefix', () => {
    const text = encodeUserEvent(event(USER));
    expect(text.startsWith(`${AGENCY}:${USER}|{`)).toBe(true);
    expect(userEventRecipient(text)).toEqual({ agencyId: AGENCY, userId: USER });
    expect(userEventRecipient(JSON.stringify(event(USER)))).toBeNull();
    // a prefix naming another member than the event is malformed
    expect(decodeUserEvent(`${AGENCY}:${OTHER}|${JSON.stringify(event(USER))}`)).toBeNull();
    // the previous release's unprefixed messages still decode (rolling deploy)
    expect(decodeUserEvent(JSON.stringify(event(USER)))).toEqual(event(USER));
    // REALTIME_PREFIX_EVENTS off (the release that ships the prefix): publishers write the previous form
    expect(encodeUserEvent(event(USER), { prefix: false })).toBe(JSON.stringify(event(USER)));
  });

  it('[S12-F4] a non-local event is skipped without parsing; a local one is parsed and handed on', async () => {
    const sub = fakeSubscriber();
    const handled: UserEvent[] = [];
    const logger = createLogger({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const isLocal = vi.fn((agencyId: string, userId: string) => agencyId === AGENCY && userId === USER);
    const stop = await subscribeUserEvents(sub, (e) => handled.push(e), logger, { isLocal });
    const local = encodeUserEvent(event(USER));
    const remote = encodeUserEvent(event(OTHER));

    const parse = vi.spyOn(JSON, 'parse');
    sub.emit('message', USER_EVENTS_CHANNEL, remote);
    // even a broken body is never looked at when the prefix names a member with no socket here
    sub.emit('message', USER_EVENTS_CHANNEL, `${AGENCY}:${OTHER}|not json at all`);
    expect(parse).not.toHaveBeenCalled();
    expect(isLocal).toHaveBeenCalledWith(AGENCY, OTHER);
    expect(handled).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    sub.emit('message', USER_EVENTS_CHANNEL, local);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(handled).toEqual([event(USER)]);
    await stop();
  });

  it('[S12-F4] a lost subscriber connection is logged (and counted in inmolink.realtime.subscriber_disconnects)', async () => {
    const sub = fakeSubscriber();
    const logger = createLogger({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const stop = await subscribeUserEvents(sub, () => {}, logger);
    sub.emit('close');
    expect(warn).toHaveBeenCalledWith({ channel: USER_EVENTS_CHANNEL }, 'user events subscriber disconnected');
    // failed reconnect attempts close again without a ready in between: not counted again
    sub.emit('close');
    sub.emit('close');
    expect(warn).toHaveBeenCalledTimes(1);
    // back up, then lost again: counted
    sub.emit('ready');
    sub.emit('close');
    expect(warn).toHaveBeenCalledTimes(2);
    await stop();
    sub.emit('ready');
    sub.emit('close');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
