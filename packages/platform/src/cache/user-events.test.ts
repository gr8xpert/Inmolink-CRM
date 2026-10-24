import { describe, expect, it } from 'vitest';
import { decodeUserEvent, encodeUserEvent, MAX_USER_EVENT_BYTES } from './user-events';

const USER = '0192a0b4-0000-7000-8000-000000000001';

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
