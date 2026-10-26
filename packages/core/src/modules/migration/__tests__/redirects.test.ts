import { describe, expect, it } from 'vitest';
import { buildRedirectRows, normalizeLegacyUrl } from '../redirects';

/** Pure parts of the legacy redirect maps (S14-05); the resolver and hit counters run in redirects.int.test.ts. */

const L1 = '11111111-1111-4111-8111-111111111111';
const target = (entity: string, id: string, locale: string) => `/${locale || 'es'}/${entity}/${id}`;

describe('legacy URL normalization', () => {
  it('[S14-05] one key for case, trailing slash, double slash, fragment and tracking params', () => {
    const a = normalizeLegacyUrl('https://www.inmolink.es/es/Propiedad/Villa-1/?utm_source=x#top');
    const b = normalizeLegacyUrl('/es//propiedad/villa-1');
    expect(a).toEqual({ locale: 'es', pathKey: '/es/propiedad/villa-1' });
    expect(b).toEqual(a);
  });

  it('[S14-05] plugin URLs keep only the identifying query keys, sorted', () => {
    const k = normalizeLegacyUrl('/?ref=AB1&id=7&utm_medium=mail&PHPSESSID=zz');
    expect(k).toEqual({ locale: '', pathKey: '/?id=7&ref=ab1' });
  });

  it('[S14-05] rejects what cannot be a legacy URL', () => {
    expect(normalizeLegacyUrl('')).toBeNull();
    expect(normalizeLegacyUrl('/a%ZZ')).toBeNull();
    expect(normalizeLegacyUrl(`/${'a'.repeat(3000)}`)).toBeNull();
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
        { source: 'plugin', url: '/a%ZZ', entity: 'page', staticTarget: '/es' },
      ],
    });
    expect(res.rows.map((r) => [r.locale, r.pathKey, r.targetPath])).toEqual([
      ['en', '/en/property/42', `/en/listing/${L1}`],
      ['es', '/es/propiedad/42', `/es/listing/${L1}`],
      ['es', '/es/quienes-somos', '/es/about'],
    ]);
    expect(res.unmapped.map((u) => u.reason)).toEqual(['no-map', 'no-target', 'invalid-url']);
  });

  it('[S14-05] two spellings of one URL make one row', () => {
    const res = buildRedirectRows({
      maps,
      targetPath: target,
      entries: [
        { source: 'portal', url: '/es/propiedad/42/', entity: 'listing', legacyId: '42' },
        { source: 'portal', url: '/ES/Propiedad/42', entity: 'listing', legacyId: '42' },
      ],
    });
    expect(res.rows).toHaveLength(1);
  });
});
