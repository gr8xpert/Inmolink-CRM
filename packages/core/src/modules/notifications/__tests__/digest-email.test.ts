import { describe, expect, it } from 'vitest';
import { DIGEST_LISTED, renderDigest } from '../digest-email';

const at = new Date('2026-10-24T10:00:00Z');

describe('notification digest e-mail', () => {
  it('[S11-04] lists the notifications in the member’s language, escaped, with how many more', () => {
    const items = Array.from({ length: DIGEST_LISTED + 3 }, (_, i) => ({
      type: 'CHAT_MESSAGE',
      params: { actor: 'Ana <b>', subject: `Villa ${i}` },
      createdAt: at,
    }));
    const en = renderDigest({ to: 'a@example.com', name: 'Luis', locale: 'en', items });
    expect(en.subject).toBe(`You have ${DIGEST_LISTED + 3} new notifications`);
    expect(en.text).toContain('New message from Ana <b>: Villa 0');
    expect(en.text).not.toContain(`Villa ${DIGEST_LISTED}`);
    expect(en.text).toContain('and 3 more');
    expect(en.html).toContain('Ana &lt;b&gt;');
    expect(en.html).not.toContain('<b>');
    expect(en.tag).toBe('notifications.digest');
    const es = renderDigest({ to: 'a@example.com', name: 'Luis', locale: 'es', items: items.slice(0, 1) });
    expect(es.subject).toBe('Tienes 1 notificación nueva');
    expect(es.text).toContain('Nuevo mensaje de Ana <b>: Villa 0');
  });

  it('[S11-04] a param the emitter left out reads as empty, never as a raw placeholder', () => {
    const mail = renderDigest({
      to: 'a@example.com',
      name: 'Luis',
      locale: 'xx',
      items: [{ type: 'NETWORK_POST', params: {}, createdAt: at }],
    });
    expect(mail.text).toContain('New network post: ');
    expect(mail.text).not.toContain('{subject}');
  });
});
