import { describe, expect, it } from 'vitest';
import {
  brandColor,
  brandStyle,
  EMBED_DEFAULT_COLORS,
  embedBranding,
  embedFrameAncestors,
  httpsUrl,
  onColor,
  plainBrandText,
} from '../embed-branding';

/** Embed branding (S7-F8): every agency-supplied value is reduced to a strict shape before it reaches HTML or CSS. */

const PRESENTER = {
  name: 'Costa Homes',
  email: 'hello@costa-homes.example',
  phone: '+34 600 000 001',
  whatsapp: '+34 600 000 002',
  website: 'https://costa-homes.example/',
  primaryColor: '#0A7',
  accentColor: '#112233',
};

describe('embed branding sanitizer (S7-F8)', () => {
  it('[S7-F8] brand colours pass only as #rgb / #rrggbb — never raw CSS', () => {
    expect(brandColor('#0A7')).toBe('#0a7');
    expect(brandColor(' #112233 ')).toBe('#112233');
    for (const bad of [
      'red',
      '#12345',
      '#1122334',
      '#112233;background:url(https://evil.example/x)',
      '#112233}body{display:none',
      'rgb(0,0,0)',
      'expression(alert(1))',
      'var(--x)',
      '#11223g',
      '',
      null,
    ]) {
      expect(brandColor(bad), String(bad)).toBeNull();
    }
    // The CSS custom properties carry checked hex values only (defaults when none).
    const style = brandStyle({ primaryColor: brandColor('#fff;}x{'), accentColor: brandColor('#000000') });
    expect(style).toEqual({
      '--embed-primary': EMBED_DEFAULT_COLORS.primary,
      '--embed-on-primary': '#ffffff',
      '--embed-accent': '#000000',
      '--embed-on-accent': '#ffffff',
    });
    for (const v of Object.values(style)) expect(v).toMatch(/^#[0-9a-f]{3,6}$/);
    // Readable text on the brand colour (AA): dark text on light colours, white on dark ones.
    expect(onColor('#ffff00')).toBe('#111111');
    expect(onColor('#1f2937')).toBe('#ffffff');
  });

  it('[S7-F8] logo and website URLs are https only, absolute, without credentials', () => {
    expect(httpsUrl('https://cdn.example/logo.png')).toBe('https://cdn.example/logo.png');
    for (const bad of [
      'http://cdn.example/logo.png',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '//cdn.example/logo.png',
      '/logo.png',
      'https://user:pass@cdn.example/logo.png',
      'ftp://cdn.example/x',
      `https://cdn.example/${'a'.repeat(3_000)}`,
    ]) {
      expect(httpsUrl(bad), bad.slice(0, 40)).toBeNull();
    }
    const b = embedBranding(
      { ...PRESENTER, website: 'javascript:alert(document.cookie)' },
      { logoUrl: 'http://insecure.example/logo.png' },
    );
    expect(b.website).toBeNull();
    expect(b.logoUrl).toBeNull();
    expect(embedBranding(PRESENTER, { logoUrl: 'https://cdn.example/l.webp' }).logoUrl).toBe(
      'https://cdn.example/l.webp',
    );
  });

  it('[S7-F8] texts are plain one-line text; contacts must look like contacts', () => {
    expect(plainBrandText('Costa‮ Homes\n<script>x</script>\u0000')).toBe('Costa Homes <script>x</script>');
    expect(plainBrandText('x'.repeat(500))).toHaveLength(120);
    expect(plainBrandText('   ')).toBeNull();
    const b = embedBranding({
      ...PRESENTER,
      name: '<img src=x onerror=alert(1)>​ Costa',
      email: 'x@y.example"><script>',
      phone: '+34 600<script>',
      whatsapp: 'wa.me/evil',
    });
    // The name stays text (React escapes it when rendering); markup never becomes HTML.
    expect(b.name).toBe('<img src=x onerror=alert(1)> Costa');
    expect(b.email).toBeNull();
    expect(b.phone).toBeNull();
    expect(b.whatsapp).toBeNull();
    expect(embedBranding(PRESENTER)).toEqual({
      name: 'Costa Homes',
      email: 'hello@costa-homes.example',
      phone: '+34 600 000 001',
      whatsapp: '34600000002',
      website: 'https://costa-homes.example/',
      logoUrl: null,
      primaryColor: '#0a7',
      accentColor: '#112233',
    });
  });

  it("[S7-F8] frame-ancestors come from the site's stored domains only: https hosts, no wildcard or anything else", () => {
    expect(embedFrameAncestors(['www.costa-homes.example', 'costa-homes.example'])).toEqual([
      'https://www.costa-homes.example',
      'https://costa-homes.example',
    ]);
    // Anything that is not a plain host name is dropped (a stored value is checked again, never trusted).
    expect(
      embedFrameAncestors([
        '*',
        '*.costa-homes.example',
        'https://evil.example',
        'evil.example:8443',
        'evil.example/path',
        "evil.example 'unsafe-inline'",
        'evil.example;script-src *',
        'localhost',
        'EVIL.EXAMPLE',
      ]),
    ).toEqual([]);
    expect(embedFrameAncestors([])).toEqual([]);
  });
});
