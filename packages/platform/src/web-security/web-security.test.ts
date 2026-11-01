import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newNonce, PAGE_BASE_CSP, TURNSTILE_ORIGIN } from './index.mjs';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage']);

/** Source files (not tests) of the apps and packages. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(?:ts|tsx|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Each shared helper: what defining it again looks like. */
const DEFINITIONS: Record<string, RegExp> = {
  TURNSTILE_ORIGIN: /(?:const|let|var)\s+TURNSTILE_ORIGIN\s*=/,
  PAGE_BASE_CSP: /"frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"/,
  newNonce: /function\s+newNonce\b|const\s+newNonce\s*=/,
  stepUpCheck: /identity\.verifyStepUp\(/,
  consentValue: /`v\$\{CONSENT_VERSION\}\./,
};

describe('web-security (S17-F1)', () => {
  it('[S17-F1] one home for the shared browser-security helpers: Turnstile origin, base page CSP, nonce', () => {
    expect(TURNSTILE_ORIGIN).toBe('https://challenges.cloudflare.com');
    for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) {
      expect(PAGE_BASE_CSP).toContain(directive);
    }
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(nonce);
  });

  it('[S17-F1] each S16 security helper is defined once across apps, packages and the e2e suite', () => {
    const files = ['apps', 'packages', 'tests/e2e'].flatMap((d) => sources(join(REPO, d)));
    const found = Object.fromEntries(
      Object.entries(DEFINITIONS).map(([name, re]) => [
        name,
        files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f).replaceAll('\\', '/')),
      ]),
    );
    expect(found).toEqual({
      TURNSTILE_ORIGIN: ['packages/platform/src/web-security/index.mjs'],
      PAGE_BASE_CSP: ['packages/platform/src/web-security/index.mjs'],
      newNonce: ['packages/platform/src/web-security/index.mjs'],
      stepUpCheck: ['packages/core/src/step-up.ts'],
      consentValue: ['apps/web/src/components/legal/cookie-consent.ts'],
    });
  });
});
