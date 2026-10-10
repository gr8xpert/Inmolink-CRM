import { describe, expect, it } from 'vitest';
import { catalogs, negotiateLocale, PACKAGE_NAME, translator, UI_LOCALES } from './index';

type Tree = { [key: string]: string | Tree };
const keysOf = (tree: Tree, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : keysOf(v, `${prefix}${k}.`)));

describe('@inmolink/i18n', () => {
  it('[S0-01] exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@inmolink/i18n');
  });

  it('[S0-09] EN and ES auth catalogs have exactly the same keys', () => {
    expect(UI_LOCALES).toEqual(['en', 'es']);
    expect(keysOf(catalogs.es.auth).sort()).toEqual(keysOf(catalogs.en.auth).sort());
  });

  it('[S0-09] translates with interpolation and negotiates Accept-Language', () => {
    expect(translator('es', 'auth')('signup.passwordHint', { min: 10 })).toBe('Al menos 10 caracteres.');
    expect(translator('en', 'auth')('missing.key')).toBe('missing.key');
    expect(negotiateLocale('es-ES,es;q=0.9,en;q=0.8')).toBe('es');
    expect(negotiateLocale('de-DE,de;q=0.9,es;q=0.5')).toBe('es');
    expect(negotiateLocale('fr')).toBe('en');
    expect(negotiateLocale(null)).toBe('en');
  });
});
