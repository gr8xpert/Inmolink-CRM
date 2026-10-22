import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import locales from '@inmolink/i18n/locales.json' with { type: 'json' };
import { afterAll, describe, expect, it } from 'vitest';
import { buildWidget } from '../../widget-build';
import { connection, safeBaseUrl } from './connection';
import { pickLang, translate, WIDGET_LANGS } from './messages';

const MAX_GZIP_BYTES = 60 * 1024;
const out = mkdtempSync(join(tmpdir(), 'inmolink-widget-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('JS widget (S8-06)', () => {
  it('[S8-06] widget bundle ≤ 60 KB gzip', async () => {
    // Built once into a directory of its own (not the shared dist-widget/ of the turbo build).
    const script = readFileSync(await buildWidget(out));
    expect(gzipSync(script, { level: 6 }).length).toBeLessThanOrEqual(MAX_GZIP_BYTES);
    // Self-contained: no import, require or dynamic import of code at load time.
    expect(script.toString()).not.toMatch(/\brequire\(|\bimport\(|^import /m);
  }, 120_000);

  it('[S8-06] UI strings come in every UI language of locales.json, English for any other language', () => {
    expect([...WIDGET_LANGS].sort()).toEqual([...locales.ui.locales].sort());
    expect(pickLang('es-ES')).toBe('es');
    expect(pickLang('de')).toBe('en');
    expect(pickLang(undefined)).toBe('en');
    expect(translate('es', 'total', { count: 3 })).toBe('3 propiedades');
    expect(translate('es', 'total', { count: 1 })).toBe('1 propiedad');
    expect(translate('en', 'beds', { count: 1 })).toBe('1 bedroom');
    expect(translate('en', 'beds', { count: 4 })).toBe('4 bedrooms');
    expect(translate('en', 'ref', { ref: 'X-1' })).toBe('Ref. X-1');
  });

  it('[S8-06] the API key goes only to the URL it is paired with, and the URL must be https', () => {
    const script = { apiKey: 'inl_test_pk1', baseUrl: 'https://feed.example' };
    expect(connection({}, script)).toEqual({ apiKey: 'inl_test_pk1', baseUrl: 'https://feed.example' });
    // An element that names its own URL does not get the script's key.
    expect(connection({ baseUrl: 'https://evil.example' }, script)).toBeUndefined();
    expect(connection({ apiKey: 'k', baseUrl: 'https://own.example' }, script)).toEqual({
      apiKey: 'k',
      baseUrl: 'https://own.example',
    });
    expect(safeBaseUrl('http://feed.example')).toBeUndefined();
    expect(safeBaseUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeBaseUrl('not a url')).toBeUndefined();
    expect(safeBaseUrl('http://localhost:3000/x')).toBe('http://localhost:3000');
    expect(connection({}, { apiKey: 'k', baseUrl: 'http://feed.example' })).toBeUndefined();
  });
});
