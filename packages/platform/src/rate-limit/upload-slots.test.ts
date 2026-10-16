import { describe, expect, it } from 'vitest';
import { createUploadSlots } from './upload-slots';

describe('upload slots', () => {
  it('[S3-F8] a user holds at most the cap of buffered uploads; a released slot is free again, once', () => {
    const slots = createUploadSlots(2);
    const first = slots.take('u1');
    const second = slots.take('u1');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(slots.take('u1')).toBeNull();
    // Another user is not affected.
    expect(slots.take('u2')).not.toBeNull();

    first?.();
    first?.(); // a second release does not free a slot the user still holds
    expect(slots.held('u1')).toBe(1);
    expect(slots.take('u1')).not.toBeNull();
    expect(slots.take('u1')).toBeNull();
  });

  it('[S3-F10] the process holds at most `total` bodies, whoever sends them', () => {
    const slots = createUploadSlots(2, 3);
    const held = ['u1', 'u2', 'u3'].map((u) => slots.take(u));
    expect(held.every((r) => r !== null)).toBe(true);
    expect(slots.take('u4')).toBeNull();
    expect(slots.total()).toBe(3);
    held[0]?.();
    held[0]?.();
    expect(slots.total()).toBe(2);
    expect(slots.take('u4')).not.toBeNull();
  });
});
