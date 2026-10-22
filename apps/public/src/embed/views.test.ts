import type { WebsiteDetail } from '@inmolink/contracts';
import { brandStyle, embedBranding } from '@inmolink/core/modules/website-api';
import { formatter } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { describe, expect, it } from 'vitest';
import { EmbedContact, EmbedDetailView } from './views';

/** Embed views (S7-F8): agency-supplied texts are rendered as text, never as HTML; unsafe URLs never become links. */

const hostile = embedBranding({
  name: '<script>alert(1)</script><img src=x onerror=alert(2)> Costa',
  email: 'hello@costa.example',
  phone: '+34 600 000 001',
  whatsapp: null,
  website: 'javascript:alert(3)',
  primaryColor: 'red;}</style><script>alert(4)</script>',
  accentColor: '#0a7',
});

const t = translator('en', 'embed');
const text = { t, fmt: formatter('en') };

describe('embed views (S7-F8)', () => {
  it('[S7-F8] branding texts are escaped and unsafe URLs or colours never reach the page', () => {
    const html = String(EmbedContact({ branding: hostile, t }));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="mailto:hello@costa.example"');
    expect(html).toContain('href="tel:+34600000001"');
    // The style attribute carries checked hex values only.
    const style = brandStyle(hostile);
    expect(Object.values(style).join(' ')).not.toMatch(/[;{}<>()]/);
  });

  it('[S7-F8] listing text is plain text: markup in a description is shown, not run', () => {
    const detail = {
      kind: 'LISTING',
      id: '01900000-0000-7000-8000-000000000001',
      ref: 'CE-AB12CD34',
      status: 'ACTIVE',
      transactionType: 'SALE',
      price: { amountCents: 45_000_000, currency: 'EUR', period: null, onRequest: false },
      propertyType: { id: '01900000-0000-7000-8000-000000000002', name: 'Villa', slug: 'villa' },
      place: {
        country: null,
        region: null,
        city: { id: '01900000-0000-7000-8000-000000000003', name: 'Harbour', slug: 'h' },
        area: null,
      },
      bedrooms: 3,
      bathrooms: 2,
      builtM2: 180,
      plotM2: null,
      geo: null,
      cover: null,
      imageCount: 0,
      developmentId: null,
      developmentRef: null,
      title: 'Villa <b>bold</b>',
      slug: 'villa',
      textLocale: null,
      description: 'Sea views.\n\n<iframe src="https://evil.example"></iframe>',
      metaTitle: null,
      metaDescription: null,
      terraceM2: null,
      yearBuilt: null,
      energyRating: 'B',
      energyEmissionsRating: null,
      features: [],
      media: [],
      agency: {
        name: 'x',
        email: null,
        phone: null,
        whatsapp: null,
        website: null,
        primaryColor: null,
        accentColor: null,
      },
    } as unknown as WebsiteDetail;
    const html = String(EmbedDetailView({ detail, branding: hostile, backHref: '/embed/x/en', text }));
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;iframe');
    expect(html).toContain('€450,000');
    expect(html).toContain('3 bedrooms');
  });
});
