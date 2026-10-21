import type { WebsitePresenter } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { renderLeadAck, renderLeadNotification } from '../emails';

const presenter: WebsitePresenter = {
  name: 'Costa Homes',
  email: 'hello@costa.example',
  phone: '+34 600 000 001',
  whatsapp: null,
  website: 'https://www.costa.example',
  primaryColor: '#0a7d5a',
  accentColor: null,
};

const ack = (p: Partial<WebsitePresenter> = {}, locale = 'en') =>
  renderLeadAck({
    to: 'ana@example.com',
    name: 'Ana',
    locale,
    kind: 'ENQUIRY',
    ref: 'CH-7KQ2M9XA',
    presenter: { ...presenter, ...p },
    similar: [],
  });

describe('website lead e-mails (S7-05)', () => {
  it("[S7-05] the acknowledgement carries the site's branding: name, colour, contacts and website", () => {
    const m = ack();
    expect(m.subject).toBe('We have received your enquiry – Costa Homes');
    expect(m.html).toContain('background:#0a7d5a');
    expect(m.html).toContain('href="https://www.costa.example/"');
    expect(m.text).toContain('Phone: +34 600 000 001');
    expect(m.text).toContain('property CH-7KQ2M9XA');
  });

  it('[S7-05] only plain hex colours and https links reach the HTML; other languages fall back to English', () => {
    const m = ack({ primaryColor: 'red;background:url(x)', website: 'javascript:alert(1)' });
    expect(m.html).not.toContain('url(x)');
    expect(m.html).not.toContain('javascript:');
    expect(m.html).toContain('background:#1f2937');
    expect(ack({}, 'es').subject).toBe('Hemos recibido su consulta – Costa Homes');
    expect(ack({}, 'de').subject).toBe('We have received your enquiry – Costa Homes');
  });

  it('[S7-05] the agency notification lists the visitor details and escapes them', () => {
    const m = renderLeadNotification({
      to: 'office@costa.example',
      locale: 'es',
      kind: 'ENQUIRY',
      ref: null,
      siteName: 'Costa web',
      lead: {
        name: 'Ana & Co',
        email: 'ana@example.com',
        phone: null,
        message: '<b>hi</b>',
        locale: 'de',
        marketingConsent: true,
        pageUrl: null,
        slots: [],
      },
    });
    expect(m.subject).toBe('Nueva consulta web');
    expect(m.text).toContain('Acepta correos comerciales: Sí');
    expect(m.html).toContain('Ana &amp; Co');
    expect(m.html).toContain('&lt;b&gt;hi&lt;/b&gt;');
  });
});
