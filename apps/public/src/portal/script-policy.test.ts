import { describe, expect, it } from 'vitest';
import PortalPageCacheHandler from '../../cache-handler.mjs';
import {
  FALLBACK_PAGE_CSP,
  hashedScriptSrc,
  newNonce,
  PAGE_BASE_CSP,
  portalScriptSrc,
  TURNSTILE_ORIGIN,
} from '../../script-policy.mjs';
import {
  CSP_HEADER,
  inlineScriptHashes,
  isNextInlineScript,
  MAX_SCRIPT_HASHES,
  storedPageScriptPolicy,
  withStoredPageScriptPolicy,
} from '../../stored-page-policy.mjs';
import { TURNSTILE_ORIGIN as EMBED_TURNSTILE_ORIGIN } from '../embed/csp';

const N = 'AAAAAAAAAAAAAAAAAAAAAA==';

/** The inline scripts Next 16 writes into a page (shapes copied from a rendered listing page). */
const BOOT = '(self.__next_f=self.__next_f||[]).push([0])';
const TURBO =
  '(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push({"otherChunks":["static/chunks/2ab6l8ymf-drv.js","static/chunks/2l-6g6sy2esm_.js"],"runtimeModuleIds":[99129]});';
const FLIGHT_1 =
  'self.__next_f.push([1,"1:\\"$Sreact.fragment\\"\\n2:\\"/_next/static/chunks/1imq-rnzbv_qv.js\\"\\n"])';
const FLIGHT_2 =
  'self.__next_f.push([1,"b:[\\"$\\",\\"h1\\",null,{\\"children\\":\\"Villa \\u003cb\\u003e in Jávea\\"}]\\n"])';

/** A stored ISR page: no nonce on any script (Next renders it statically). */
const isrPage = (extra = '') =>
  '<!DOCTYPE html><html><head><script src="/_next/static/chunks/a.js" async=""></script>' +
  `<script id="_R_">${TURBO}</script></head><body><h1>Villa</h1>` +
  '<script type="application/ld+json">{"@type":"RealEstateListing"}</script>' +
  `${extra}<script>${BOOT}</script><script>${FLIGHT_1}</script><script>${FLIGHT_2}</script></body></html>`;

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

const REPORT = 'report-uri /api/csp-report';
const stored = (html: string) => storedPageScriptPolicy(html).policy;

describe('portal script policy (S16-F8)', () => {
  it('[S16-F8] a per-request page’s script-src runs only its nonced inline scripts: no unsafe-inline, strict-dynamic or eval', () => {
    const csp = portalScriptSrc(N);
    expect(csp).toBe(`script-src 'self' 'nonce-${N}' ${TURNSTILE_ORIGIN}`);
    // A CDN copy reuses its nonce: without 'strict-dynamic' it cannot vouch for any other script.
    expect(csp).not.toMatch(/unsafe-inline|strict-dynamic|unsafe-eval/);
    expect(portalScriptSrc(N, true)).toContain("'unsafe-eval'");
    // The enquiry form's Turnstile host is the embeds' one.
    expect(TURNSTILE_ORIGIN).toBe(EMBED_TURNSTILE_ORIGIN);
    // Nothing but a nonce of ours ever becomes a source (no quote or `;` can end the directive).
    for (const bad of ['', "x' 'unsafe-inline", 'abc;script-src *', `${N} `]) {
      expect(() => portalScriptSrc(bad), bad).toThrow(TypeError);
    }
    const a = newNonce();
    expect(portalScriptSrc(a)).toContain(`'nonce-${a}'`);
    expect(newNonce()).not.toBe(a);
    // The fallback of an answer without a script-src of its own runs no inline script at all.
    expect(FALLBACK_PAGE_CSP).toBe(`${PAGE_BASE_CSP}; script-src 'self' ${TURNSTILE_ORIGIN}; ${REPORT}`);
  });

  it('[S16-F8] a stored page’s script-src lists the SHA-256 of each of Next’s inline scripts, never unsafe-inline or strict-dynamic', async () => {
    const { hashes, dropped } = inlineScriptHashes(isrPage());
    expect(dropped).toBe(0);
    expect(hashes).toEqual([await sha256(TURBO), await sha256(BOOT), await sha256(FLIGHT_1), await sha256(FLIGHT_2)]);
    const csp = stored(isrPage());
    expect(csp).toBe(`script-src 'self' ${TURNSTILE_ORIGIN} ${hashes.map((h) => `'${h}'`).join(' ')}; ${REPORT}`);
    expect(csp).not.toMatch(/unsafe-inline|strict-dynamic|unsafe-eval/);
    // A repeat is listed once; only well-formed hash sources ever reach the header.
    expect(inlineScriptHashes(isrPage(`<script>${BOOT}</script>`)).hashes).toHaveLength(4);
    expect(hashedScriptSrc(["sha256-x' 'unsafe-inline", 'nonce-abc'])).toBe(`script-src 'self' ${TURNSTILE_ORIGIN}`);
    // The same scripts carrying Next's nonce (a page rendered per request) hash the same.
    expect(
      inlineScriptHashes(`<script nonce="${N}" id="_R_">${TURBO}</script><script nonce="${N}">${BOOT}</script>`).hashes,
    ).toEqual([await sha256(TURBO), await sha256(BOOT)]);
  });

  it('[S16-F8] anything inline that is not Next’s own shape gets no hash (the browser refuses it); JSON-LD is never hashed', () => {
    const injected = [
      '<script>alert(1)</script>',
      '<script>self.__next_f.push([1,"x"]);alert(1)</script>',
      '<script>self.__next_f.push([1,"x"],alert(1))</script>',
      '<script>self.__next_f.push(alert(1))</script>',
      '<script>(self.__next_f=self.__next_f||[]).push([0]);alert(1)</script>',
      // The chunk bootstrap only as Next writes it: id `_R_`, chunk paths and module ids.
      `<script>${TURBO}</script>`,
      '<script id="_R_">(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push({"otherChunks":["https://evil.example/x.js"]});</script>',
      '<script id="_R_">(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push({"x":1});</script>',
      '<script type="module">self.__next_f.push([1,"x"])</script>',
      '<script src="https://evil.example/x.js"></script>',
    ];
    const base = inlineScriptHashes(isrPage()).hashes;
    for (const extra of injected) expect(inlineScriptHashes(isrPage(extra)).hashes, extra).toEqual(base);
    expect(isNextInlineScript('self.__next_f.push([2,"form"])', false)).toBe(false);
    expect(isNextInlineScript('self.__next_f.push([3,"AAEC"])', false)).toBe(true);
    expect(isNextInlineScript(TURBO, true)).toBe(true);
    expect(isNextInlineScript(TURBO, false)).toBe(false);
    expect(stored('<script type="application/ld+json">{}</script>')).toBe(
      `script-src 'self' ${TURNSTILE_ORIGIN}; ${REPORT}`,
    );
  });

  it('[S16-F8] at most 64 hashes per page (a small header); past the cap the rest is refused and the cap is reported', () => {
    expect(MAX_SCRIPT_HASHES).toBe(64);
    const many = Array.from(
      { length: MAX_SCRIPT_HASHES + 5 },
      (_, i) => `<script>self.__next_f.push([1,"${i}"])</script>`,
    ).join('');
    const { hashes, dropped } = inlineScriptHashes(many);
    expect(hashes).toHaveLength(MAX_SCRIPT_HASHES);
    expect(dropped).toBe(5);
    expect(stored(many).length).toBeLessThan(4_000);
    const capped: number[] = [];
    withStoredPageScriptPolicy({ kind: 'APP_PAGE', html: many }, { onCapped: (n) => capped.push(n) });
    withStoredPageScriptPolicy({ kind: 'APP_PAGE', html: isrPage() }, { onCapped: (n) => capped.push(n) });
    expect(capped).toEqual([5]);
  });

  it('[S16-F8] an ISR entry keeps its page’s policy in the headers Next serves the first answer from; other entries are untouched', () => {
    const headers: Record<string, string> = { 'x-next-cache-tags': 'portal:t:1' };
    const entry = { kind: 'APP_PAGE', html: isrPage(), headers, status: 200 };
    expect(withStoredPageScriptPolicy(entry)).toBe(entry);
    // In place: the same object Next's response for this render reads.
    expect(headers[CSP_HEADER]).toBe(stored(isrPage()));
    expect(headers['x-next-cache-tags']).toBe('portal:t:1');
    const bare: { kind: string; html: string; headers?: Record<string, string> } = {
      kind: 'APP_PAGE',
      html: isrPage(),
    };
    expect(withStoredPageScriptPolicy(bare).headers?.[CSP_HEADER]).toBe(stored(isrPage()));
    const fetchEntry = { kind: 'FETCH', data: { body: '<script>x</script>' } };
    expect(withStoredPageScriptPolicy(fetchEntry)).toEqual({ kind: 'FETCH', data: { body: '<script>x</script>' } });
    const rsc = { kind: 'APP_PAGE', html: { not: 'a string' } };
    expect(withStoredPageScriptPolicy(rsc)).toEqual({ kind: 'APP_PAGE', html: { not: 'a string' } });
  });

  it('[S16-F8] the page cache handler stores each page with its own script policy; a re-render replaces it', async () => {
    const handler = new PortalPageCacheHandler({ maxMemoryCacheSize: 1024 * 1024 });
    const key = `/en/property/s16-f8-${Date.now()}`;
    const first = { kind: 'APP_PAGE', html: isrPage(), headers: {} as Record<string, string>, status: 200 };
    await handler.set(key, first, { tags: [] });
    expect(first.headers[CSP_HEADER]).toBe(stored(isrPage()));
    const hit = (await handler.get(key)) as { value: { headers: Record<string, string> } };
    expect(hit.value.headers[CSP_HEADER]).toBe(stored(isrPage()));
    // Revalidated: new HTML (a price change), its own hashes.
    const changed = isrPage().replace(FLIGHT_2, FLIGHT_2.replace('Villa', 'Finca'));
    await handler.set(key, { kind: 'APP_PAGE', html: changed, headers: {}, status: 200 }, { tags: [] });
    const again = (await handler.get(key)) as { value: { headers: Record<string, string> } };
    expect(again.value.headers[CSP_HEADER]).toBe(stored(changed));
    expect(again.value.headers[CSP_HEADER]).not.toBe(hit.value.headers[CSP_HEADER]);
  });
});
