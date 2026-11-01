import { createHash } from 'node:crypto';
import type { APIResponse, BrowserContext } from '@playwright/test';
import { expect } from './fixtures';

/**
 * S16-F8: collects every Content-Security-Policy violation in a browser context — the page's own
 * `securitypolicyviolation` events and the browser's "Refused to …" console errors. A spec asserts none at its end.
 */
export async function watchCsp(context: BrowserContext): Promise<{ violations: string[]; expectNone: () => void }> {
  const violations: string[] = [];
  context.on('console', (msg) => {
    const text = msg.text();
    if (/content[- ]security[- ]policy|securitypolicyviolation/i.test(text))
      violations.push(`${msg.page()?.url()}: ${text}`);
  });
  // A string (the specs compile without the DOM lib); runs in every page before its own scripts.
  await context.addInitScript({
    content: `document.addEventListener('securitypolicyviolation', (e) => console.error(
      'securitypolicyviolation ' + e.effectiveDirective + ' ' + e.blockedURI + ' at ' + e.sourceFile + ':' + e.lineNumber));`,
  });
  return { violations, expectNone: () => expect(violations, violations.join('\n')).toEqual([]) };
}

/**
 * The enforced `script-src` of a page answer (several CSP headers are several policies; the browser applies all),
 * without `'unsafe-inline'`, and a check that it allows exactly the page's own inline scripts: by the render's nonce
 * (pages rendered per request) or by their SHA-256 (stored ISR copies). Returns the directive.
 */
export async function expectEnforcedScriptPolicy(res: APIResponse): Promise<string> {
  const policies = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'content-security-policy')
    .flatMap((h) => h.value.split(','));
  expect(res.headersArray().some((h) => /report-only/i.test(h.name))).toBe(false);
  const scripts = policies.flatMap((p) => p.split(';').map((d) => d.trim())).filter((d) => d.startsWith('script-src '));
  expect(scripts, policies.join(' | ')).toHaveLength(1);
  const [scriptSrc] = scripts as [string];
  expect(scriptSrc).not.toContain('unsafe-inline');
  const html = await res.text();
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(scriptSrc)?.[1];
  if (nonce) {
    const used = new Set([...html.matchAll(/<script\b[^>]*?\snonce="([^"]*)"/g)].map((m) => m[1]));
    expect([...used]).toEqual([nonce]);
  } else {
    // Every executable inline script (no `src`, no data `type`) is allowed by its hash.
    const inline = [...html.matchAll(/<script\b([^>]*)>([^<]*)<\/script>/g)].filter(
      ([, attrs]) => !/\bsrc=|\btype=/.test(attrs as string),
    );
    expect(inline.length).toBeGreaterThan(0);
    for (const [, , body] of inline) {
      const hash = createHash('sha256')
        .update(body as string, 'utf8')
        .digest('base64');
      expect(scriptSrc, (body as string).slice(0, 80)).toContain(`'sha256-${hash}'`);
    }
  }
  return scriptSrc;
}
