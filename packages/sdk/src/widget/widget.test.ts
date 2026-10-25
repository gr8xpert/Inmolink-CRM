import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import locales from '@inmolink/i18n/locales.json' with { type: 'json' };
import { afterAll, describe, expect, it } from 'vitest';
import { buildWidget } from '../../widget-build';
import { OPERATIONS } from '../website-v2.generated';
import { connection, safeBaseUrl } from './connection';
import { formKey } from './lead-form';
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
    // Nothing left external: an unresolved workspace import becomes a free `_inmolink_…` global (found on CI).
    expect(script.toString()).not.toMatch(/_inmolink|@inmolink/);
    // The lead form's caps come from the zod-free contracts values (S8-F8): no zod in the script.
    expect(script.toString()).not.toMatch(/ZodError|\bzod\b/);
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

describe('JS widget lead form and AI box (S8-F8)', () => {
  it('[S8-F8] each form gets a fresh Idempotency-Key the website API accepts', () => {
    const a = formKey();
    // The contracts' IdempotencyKey: 16–128 characters of [A-Za-z0-9_.:-].
    expect(a).toMatch(/^[A-Za-z0-9_.:-]{16,128}$/);
    expect(formKey()).not.toBe(a);
  });

  it('[S8-F8] the lead form settings come with the key and URL pair, never across pairs', () => {
    const script = {
      apiKey: 'inl_test_pk1',
      baseUrl: 'https://feed.example',
      turnstileSiteKey: 'site-key-script',
      privacyUrl: 'https://agency.example/privacy',
    };
    expect(connection({}, script)).toEqual(script);
    // An element with its own pair gets none of the script's lead settings…
    expect(connection({ apiKey: 'k', baseUrl: 'https://own.example' }, script)).toEqual({
      apiKey: 'k',
      baseUrl: 'https://own.example',
    });
    // …and an element without a pair cannot change the script's.
    expect(connection({ turnstileSiteKey: 'other', privacyUrl: 'https://evil.example' }, script)).toEqual(script);
  });

  it('[S8-F8] the SDK has the /v2/search/ai operation the widget AI box will use (S12-08)', () => {
    // CI fix: S12-08 added the endpoint, so the old "absent" tripwire fired. The widget's AI box is a follow-up task;
    // until it lands the widget stays structured-only (tests/apps/widget.int.test.ts).
    expect(Object.values(OPERATIONS).map((op): string => op.path)).toContain('/v2/search/ai');
  });
});
