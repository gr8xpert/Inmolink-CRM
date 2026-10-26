import { describe, expect, it } from 'vitest';
import {
  buildRedirectRows,
  isSafeRedirectTarget,
  type LegacyUrlEntry,
  normalizeHost,
  normalizeLegacyUrl,
} from '../redirects';

/** Pure parts of the legacy redirect maps (S14-05); the resolver and hit counters run in redirects.int.test.ts. */

const L1 = '11111111-1111-4111-8111-111111111111';
const target = (entity: string, id: string, locale: string) => `/${locale || 'es'}/${entity}/${id}`;

describe('legacy URL normalization', () => {
  it('[S14-05] one key for case, trailing slash, double slash, fragment and tracking params', () => {
    const a = normalizeLegacyUrl('https://www.inmolink.es/es/Propiedad/Villa-1/?utm_source=x#top');
    const b = normalizeLegacyUrl('/es//propiedad/villa-1', 'INMOLINK.es:443');
    expect(a).toEqual({ host: 'inmolink.es', locale: 'es', pathKey: '/es/propiedad/villa-1' });
    expect(b).toEqual(a);
  });

  it('[S14-05] plugin URLs keep only the identifying query keys, sorted', () => {
    const k = normalizeLegacyUrl('/?ref=AB1&id=7&utm_medium=mail&PHPSESSID=zz', 'agency-a.example');
    expect(k).toEqual({ host: 'agency-a.example', locale: '', pathKey: '/?id=7&ref=ab1' });
  });

  it('[S14-05] rejects what cannot be a legacy URL', () => {
    expect(normalizeLegacyUrl('', 'a.example')).toBeNull();
    expect(normalizeLegacyUrl('/a%ZZ', 'a.example')).toBeNull();
    expect(normalizeLegacyUrl(`/${'a'.repeat(3000)}`, 'a.example')).toBeNull();
    expect(normalizeLegacyUrl('javascript:alert(1)', 'a.example')).toBeNull();
  });

  it('[S14-review] the key names the site: a path needs a host; the request host wins over a URL host', () => {
    expect(normalizeLegacyUrl('/contacto')).toBeNull();
    expect(normalizeLegacyUrl('//evil.example/contacto')).toBeNull(); // a path, not a host
    expect(normalizeLegacyUrl('//evil.example/contacto', 'a.example')).toMatchObject({
      host: 'a.example',
      pathKey: '/evil.example/contacto',
    });
    expect(normalizeLegacyUrl('https://b.example/contacto', 'a.example')?.host).toBe('a.example');
    expect(normalizeHost('WWW.Agency-A.Example.:8080')).toBe('agency-a.example');
    for (const bad of ['', 'a/b', 'user@a.example', 'a b', 'a\\b', '..']) expect(normalizeHost(bad)).toBeNull();
  });
});

describe('redirect targets (S14 review)', () => {
  it('[S14-review] only paths on this site: no protocol-relative, backslash or control character', () => {
    for (const ok of ['/', '/es/about', '/es/listing/x?a=1&b=%2F#top']) expect(isSafeRedirectTarget(ok)).toBe(true);
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      '/es\\..\\evil',
      '/a\nb',
      '/a\tb',
      '/a\u0000',
      'es/about',
      'https://evil.example/',
      '',
      null,
      undefined,
      `/${'a'.repeat(3000)}`,
    ]) {
      expect(isSafeRedirectTarget(bad)).toBe(false);
    }
  });
});

describe('building redirect rows', () => {
  const maps = new Map([['listing:42', L1]]);

  it('[S14-05] maps legacy ids to v2 targets per locale and reports what it could not', () => {
    const res = buildRedirectRows({
      maps,
      targetPath: target,
      entries: [
        { source: 'portal', url: '/en/property/42', entity: 'listing', legacyId: '42' },
        { source: 'portal', url: '/es/propiedad/42', entity: 'listing', legacyId: '42' },
        { source: 'portal', url: '/es/propiedad/99', entity: 'listing', legacyId: '99' },
        { source: 'portal', url: '/es/quienes-somos', entity: 'page', staticTarget: '/es/about' },
        { source: 'portal', url: '/es/bad', entity: 'page', staticTarget: '//evil.example' },
        { source: 'portal', url: '/es/bad2', entity: 'page', staticTarget: '/\\evil.example' },
        { source: 'portal', url: '/es/none', entity: 'page' },
        { source: 'plugin', url: '/a%ZZ', entity: 'page', staticTarget: '/es' },
      ].map((e) => ({ ...e, host: 'inmolink.es' })) as LegacyUrlEntry[],
    });
    expect(res.rows.map((r) => [r.host, r.locale, r.pathKey, r.targetPath])).toEqual([
      ['inmolink.es', 'en', '/en/property/42', `/en/listing/${L1}`],
      ['inmolink.es', 'es', '/es/propiedad/42', `/es/listing/${L1}`],
      ['inmolink.es', 'es', '/es/quienes-somos', '/es/about'],
    ]);
    expect(res.unmapped.map((u) => u.reason)).toEqual([
      'no-map',
      'unsafe-target',
      'unsafe-target',
      'no-target',
      'invalid-url',
    ]);
  });

  it('[S14-review] the same plugin path on two agencies’ hosts makes two rows', () => {
    const res = buildRedirectRows({
      maps,
      targetPath: target,
      entries: [
        { source: 'plugin', url: '/contacto', host: 'agency-a.example', entity: 'page', staticTarget: '/es/a' },
        { source: 'plugin', url: 'https://agency-b.example/contacto', entity: 'page', staticTarget: '/es/b' },
        { source: 'plugin', url: '/contacto', entity: 'page', staticTarget: '/es/c' }, // no host: not a key
      ],
    });
    expect(res.rows.map((r) => [r.host, r.pathKey, r.targetPath])).toEqual([
      ['agency-a.example', '/contacto', '/es/a'],
      ['agency-b.example', '/contacto', '/es/b'],
    ]);
    expect(res.unmapped).toEqual([{ url: '/contacto', reason: 'invalid-url' }]);
  });

  it('[S14-05] two spellings of one URL make one row', () => {
    const res = buildRedirectRows({
      maps,
      targetPath: target,
      entries: [
        { source: 'portal', url: 'https://inmolink.es/es/propiedad/42/', entity: 'listing', legacyId: '42' },
        { source: 'portal', url: '/ES/Propiedad/42', host: 'www.inmolink.es', entity: 'listing', legacyId: '42' },
      ],
    });
    expect(res.rows).toHaveLength(1);
  });
});
