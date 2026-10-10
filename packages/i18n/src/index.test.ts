import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_LOCALE,
  formatter,
  type LocaleConfig,
  localeConfig,
  negotiateLocale,
  PACKAGE_NAME,
  parseLocaleConfig,
  UI_LOCALES,
} from './index';
import { loadMessages, translator } from './server';
import {
  checkCatalogs,
  draftCatalogs,
  MESSAGES_DIR,
  placeholders,
  readCatalog,
  readCatalogs,
  renderCatalogIndex,
} from './tools';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch copy of the shipped catalogs. */
function scratchCatalogs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-'));
  temps.push(dir);
  cpSync(MESSAGES_DIR, dir, { recursive: true });
  return dir;
}

const editJson = (file: string, edit: (json: Record<string, Record<string, string>>) => void) => {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  edit(json);
  writeFileSync(file, JSON.stringify(json));
};

describe('@inmolink/i18n', () => {
  it('[S0-01] exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@inmolink/i18n');
  });

  it('[S0-11] the shipped catalogs pass i18n:check and the bundled index is current', () => {
    expect(checkCatalogs(localeConfig).errors).toEqual([]);
    expect(renderCatalogIndex(localeConfig)).toContain("import m0 from '../messages/en/auth.json'");
    expect(UI_LOCALES).toEqual(expect.arrayContaining(['en', 'es']));
  });

  it('[S0-11] i18n:check fails on a key missing in EN or ES', () => {
    const missingInEs = scratchCatalogs();
    editJson(join(missingInEs, 'es', 'auth.json'), (j) => {
      delete j.login?.title;
    });
    expect(checkCatalogs(localeConfig, missingInEs).errors).toEqual([
      'es: auth.login.title is missing (write it by hand)',
    ]);

    const missingInEn = scratchCatalogs();
    editJson(join(missingInEn, 'en', 'auth.json'), (j) => {
      delete j.login?.title;
    });
    expect(checkCatalogs(localeConfig, missingInEn).errors).toEqual([
      'es: auth.login.title does not exist in en — remove it',
    ]);
  });

  it('[S0-11] i18n:check fails when a translation drops or renames a placeholder', () => {
    const dir = scratchCatalogs();
    editJson(join(dir, 'es', 'auth.json'), (j) => {
      (j.signup as Record<string, string>).passwordHint = 'Al menos {minimo} caracteres.';
    });
    expect(checkCatalogs(localeConfig, dir).errors).toEqual([
      'es: auth.signup.passwordHint uses {minimo} but en uses {min}',
    ]);
    expect(placeholders('Hi {name}, {count, plural, one {# day} other {# days}}')).toEqual(['count', 'name']);
  });

  it('[S0-11] adding a locale is config-only: list it, draft it, it loads', async () => {
    const dir = scratchCatalogs();
    const withDe: LocaleConfig = parseLocaleConfig({
      ...localeConfig,
      ui: { ...localeConfig.ui, locales: [...localeConfig.ui.locales, 'de'] },
    });
    expect(checkCatalogs(withDe, dir).errors).toContain('de: auth.login.title is missing (run `pnpm i18n:draft`)');

    const indexFile = join(dir, 'catalogs.generated.ts');
    expect(checkCatalogs(withDe, dir, indexFile).errors).toContain(
      'catalogs.generated.ts is out of date — run `pnpm i18n:draft`',
    );
    const first = await draftCatalogs(withDe, { dir, indexFile });
    expect(first.indexChanged).toBe(true);
    expect(readFileSync(indexFile, 'utf8')).toContain("from '../messages/de/auth.json'");
    expect(checkCatalogs(withDe, dir, indexFile).errors).toEqual([]);
    expect(first.locales.de?.added).toBeGreaterThan(10);
    expect(first.handwrittenMissing).toEqual([]);
    const check = checkCatalogs(withDe, dir);
    expect(check.errors).toEqual([]);
    expect(check.drafts.de).toEqual({ todo: first.locales.de?.added, draft: 0 });

    // Until reviewed, the drafted locale shows the EN text — never a raw key.
    const catalogs = () => readCatalogs(withDe, dir);
    expect(translator('de', 'auth', { catalogs: catalogs() })('login.title')).toBe('Log in');
    expect(loadMessages('de', { catalogs: catalogs() }).auth.login.title).toBe('Log in');
    expect(negotiateLocale('de-DE,de;q=0.9', withDe.ui.locales)).toBe('de');

    // A reviewer translates one key and removes its draft mark; re-drafting keeps it.
    editJson(join(dir, 'de', 'auth.json'), (j) => {
      (j.login as Record<string, string>).title = 'Anmelden';
    });
    editJson(join(dir, 'de', '_drafts.json'), (j) => {
      delete j.auth?.['login.title'];
    });
    const again = await draftCatalogs(withDe, { dir, indexFile });
    expect(again.locales.de).toEqual({ added: 0, removed: 0 });
    expect(again.indexChanged).toBe(false);
    expect(translator('de', 'auth', { catalogs: catalogs() })('login.title')).toBe('Anmelden');
    expect(checkCatalogs(withDe, dir).drafts.de?.todo).toBe((first.locales.de?.added ?? 0) - 1);
  });

  it('[S0-11] draft uses the machine translation hook when given, marked for review', async () => {
    const dir = scratchCatalogs();
    const withFr = parseLocaleConfig({ ...localeConfig, ui: { ...localeConfig.ui, locales: ['en', 'es', 'fr'] } });
    await draftCatalogs(withFr, { dir, indexFile: null, translate: async (texts) => texts.map((t) => `FR ${t}`) });
    expect(translator('fr', 'auth', { catalogs: readCatalogs(withFr, dir) })('login.title')).toBe('FR Log in');
    const drafts = checkCatalogs(withFr, dir).drafts.fr;
    expect(drafts?.todo).toBe(0);
    expect(drafts?.draft).toBeGreaterThan(10);
  });

  it('[S0-11] locale config is validated', () => {
    const bad = (patch: object) => () => parseLocaleConfig({ ...localeConfig, ...patch });
    expect(bad({ ui: { default: 'de', locales: ['en'], handwritten: ['en'] } })).toThrow(/ui.default/);
    expect(bad({ ui: { default: 'en', locales: ['en', '../x'], handwritten: ['en'] } })).toThrow(/invalid locale code/);
    expect(bad({ timeZone: 'Mars/Olympus' })).toThrow(/timeZone/);
    expect(DEFAULT_UI_LOCALE).toBe(localeConfig.ui.default);
  });

  it('[S0-11] translates with ICU interpolation; unknown keys come back as the key', () => {
    expect(translator('es', 'auth')('signup.passwordHint', { min: 10 })).toBe('Al menos 10 caracteres.');
    expect(translator('en', 'auth')('missing.key')).toBe('auth.missing.key');
    expect(translator('ja', 'auth')('login.title')).toBe('Log in');
    expect(() => readCatalog('../../etc')).toThrow(/invalid locale code/);
  });

  it('[S0-11] locale formatters: money from cents, area, dates in the configured zone', () => {
    expect(formatter('es').money(450_000_00, 'EUR')).toBe('450.000 €');
    expect(formatter('en').money(450_000_00, 'EUR')).toBe('€450,000');
    expect(formatter('en').money(1_234_56, 'GBP')).toBe('£1,234.56');
    expect(formatter('es').area(1250.5)).toBe('1250,5 m²');
    // 23:30 UTC on 31 Dec is already 1 Jan in Madrid.
    expect(formatter('en').date(new Date('2026-12-31T23:30:00Z'), { dateStyle: 'long' })).toBe('January 1, 2027');
    const now = new Date('2026-10-10T12:00:00Z');
    expect(formatter('es').relative(new Date('2026-10-07T12:00:00Z'), now)).toBe('hace 3 días');
  });

  it('[S0-09] negotiates Accept-Language over the configured UI locales', () => {
    expect(negotiateLocale('es-ES,es;q=0.9,en;q=0.8')).toBe('es');
    expect(negotiateLocale('de-DE,de;q=0.9,es;q=0.5')).toBe('es');
    expect(negotiateLocale('fr')).toBe('en');
    expect(negotiateLocale(null)).toBe('en');
    expect(negotiateLocale('pt-br,pt;q=0.9', ['en', 'pt', 'pt-BR'])).toBe('pt-BR');
    expect(negotiateLocale('pt-PT', ['en', 'pt', 'pt-BR'])).toBe('pt');
  });
});
