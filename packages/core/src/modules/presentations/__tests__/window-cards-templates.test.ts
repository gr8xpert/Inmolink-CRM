import { type WebsiteDetail, type WebsitePresenter, WINDOW_CARD_TEMPLATES } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { docFormat } from '../../documents';
import { windowCardsHtml, windowCardTemplate } from '../window-cards-templates';

const presenter: WebsitePresenter = {
  name: 'Alpha <Homes>',
  email: 'info@alpha.example',
  phone: '+34 600 000 000',
  whatsapp: null,
  website: 'https://alpha.example',
  primaryColor: '#112233',
  accentColor: 'not-a-colour',
};

const detail = {
  kind: 'LISTING',
  id: '11111111-1111-4111-8111-111111111111',
  ref: 'A-1',
  title: 'Sea villa <script>x</script>',
  status: 'ACTIVE',
  transactionType: 'SALE',
  price: { amountCents: 45_000_000, currency: 'EUR', onRequest: false, period: null },
  priceToCents: null,
  place: { city: null, region: null, country: null, area: null },
  bedrooms: 3,
  bathrooms: 2,
  builtM2: 120,
  plotM2: null,
  media: [],
  cover: {
    kind: 'IMAGE',
    cover: true,
    alt: null,
    room: null,
    width: 10,
    height: 10,
    urls: { large: 'https://media.example/a.webp' },
  },
} as unknown as WebsiteDetail;

const t = ((key: string, values?: Record<string, string>) =>
  values ? `${key}:${Object.values(values).join(',')}` : key) as never;

describe('window card templates (R2-06)', () => {
  it('[R2-06] at least 10 templates covering A4/A3 and portrait/landscape, unique ids', () => {
    expect(WINDOW_CARD_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(WINDOW_CARD_TEMPLATES.map((x) => x.id)).size).toBe(WINDOW_CARD_TEMPLATES.length);
    const combos = new Set(WINDOW_CARD_TEMPLATES.map((x) => `${x.size}-${x.orientation}`));
    expect(combos.size).toBe(4);
  });

  it.each(WINDOW_CARD_TEMPLATES.map((x) => x.id))(
    '[R2-06] %s: one page per card, its paper size, branding, QR, escaped text',
    (id) => {
      const tpl = windowCardTemplate(id);
      const html = windowCardsHtml({
        template: tpl,
        presenter,
        cards: [
          { detail, qrSvg: '<svg id="qr1"></svg>' },
          { detail, qrSvg: '<svg id="qr2"></svg>' },
        ],
        t,
        format: docFormat('en'),
      });
      expect(html.match(/<section class="card"/g)).toHaveLength(2);
      const [w, h] = tpl.size === 'A4' ? [210, 297] : [297, 420];
      const [pw, ph] = tpl.orientation === 'LANDSCAPE' ? [h, w] : [w, h];
      expect(html).toContain(`size: ${pw}mm ${ph}mm`);
      expect(html).toContain('#112233');
      expect(html).toContain('id="qr1"');
      expect(html).toContain('id="qr2"');
      expect(html).toContain('Alpha &lt;Homes&gt;');
      expect(html).not.toContain('<script>');
      expect(html).toContain('€450,000');
      expect(html).toContain('https://media.example/a.webp');
    },
  );

  it('[R2-06] an unknown template is refused', () => {
    expect(() => windowCardTemplate('nope')).toThrow();
  });
});
