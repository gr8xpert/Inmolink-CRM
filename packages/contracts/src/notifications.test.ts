import { describe, expect, it } from 'vitest';
import { NOTIFICATION_LIMITS, NotificationParams, notificationText } from './notifications';

describe('notificationText', () => {
  it('[S12-F2] free text becomes a display param the catalog always accepts', () => {
    const cases = [
      'Call the notary',
      'Call Ana +34 600 123 456 about the deposit',
      'Mail ana@example.com\nthen close',
      'x'.repeat(NOTIFICATION_LIMITS.paramChars + 50),
      '\u0007',
    ];
    for (const text of cases) {
      const subject = notificationText(text);
      expect(NotificationParams.safeParse({ subject }).success).toBe(true);
      expect([...subject].length).toBeLessThanOrEqual(NOTIFICATION_LIMITS.paramChars);
    }
    expect(notificationText('Call the notary')).toBe('Call the notary');
    expect(notificationText('Call Ana +34 600 123 456 now')).toBe('Call Ana … now');
    expect(notificationText('Mail ana@example.com\nthen')).toBe('Mail … then');
    expect(notificationText('\u0007')).toBe('');
  });
});
