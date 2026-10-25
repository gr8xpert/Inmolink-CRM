import { describe, expect, it } from 'vitest';
import { notificationHref } from './link';

describe('notification links', () => {
  it('[S12-F1] a notification opens the page that exists for it, and never leaves the app', () => {
    expect(notificationHref('/chat/0190-thread')).toBe('/chat/0190-thread');
    expect(notificationHref('/network/posts/0190-post')).toBe('/network/board');
    expect(notificationHref('/mls/viewings/0190-v')).toBe('/collaborations');
    expect(notificationHref('/mls/received-viewings/0190-v')).toBe('/collaborations');
    expect(notificationHref('/staff/tenants')).toBeNull();
    expect(notificationHref(null)).toBeNull();
    expect(notificationHref('https://evil.example/x')).toBeNull();
    expect(notificationHref('//evil.example/x')).toBeNull();
  });
});
