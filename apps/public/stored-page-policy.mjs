// S16-F8 (security-R1.md M-3): the script policy of an ISR page as the page cache stores it (`cache-handler.mjs`).
// Plain ESM, Node only (hashing): Next loads the cache handler at runtime, uncompiled.
//
// Next renders ISR pages without the request's nonce, so a stored page's own inline scripts are allowed by their
// SHA-256 hashes. Only the shapes Next itself writes are hashed — the flight bootstrap, the flight data pushes (a JSON
// array, `<` escaped, so the content has no tag) and the Turbopack chunk bootstrap (`id="_R_"`, chunk paths and module
// ids only); anything else inline (no hash) is refused by the browser. JSON-LD (`type="application/ld+json"`) is data,
// not script: never hashed, never run.
import { createHash } from 'node:crypto';
import { CSP_REPORT_DIRECTIVE, hashedScriptSrc } from './script-policy.mjs';

/** Plain inline `<script>` elements (optionally Next's `nonce` / `id="_R_"`); their content holds no `<`. */
const INLINE_SCRIPT = /<script((?:\s+(?:nonce="[^"<>]*"|id="_R_"))*)>([^<]*)<\/script>/g;

const FLIGHT_BOOTSTRAP = '(self.__next_f=self.__next_f||[]).push([0])';
const FLIGHT_PUSH = 'self.__next_f.push(';
const TURBOPACK_PUSH = '(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push(';
const CHUNK = /^static\/chunks\/[\w.-]+\.js$/;

/**
 * A page has a handful of inline scripts (the e2e listing page: 7, search pages 3); past this many, the rest are not
 * trusted (refused) and the cache handler logs it. 64 hashes are ~3.4 KB of header — well inside the CDN / reverse
 * proxy response-header buffers (nginx's default `proxy_buffer_size` is 4–8 KB for all headers together).
 */
export const MAX_SCRIPT_HASHES = 64;

function parse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** True for a script body Next writes into a page (see the header). */
export function isNextInlineScript(body, isTurbopackBootstrap) {
  if (body === FLIGHT_BOOTSTRAP) return true;
  if (body.startsWith(FLIGHT_PUSH) && body.endsWith(')')) {
    const v = parse(body.slice(FLIGHT_PUSH.length, -1));
    return Array.isArray(v) && v.length === 2 && (v[0] === 1 || v[0] === 3) && typeof v[1] === 'string';
  }
  if (isTurbopackBootstrap && body.startsWith(TURBOPACK_PUSH) && body.endsWith(');')) {
    const v = parse(body.slice(TURBOPACK_PUSH.length, -2));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const { otherChunks = [], runtimeModuleIds = [], ...rest } = v;
    return (
      Object.keys(rest).length === 0 &&
      Array.isArray(otherChunks) &&
      otherChunks.every((c) => typeof c === 'string' && CHUNK.test(c)) &&
      Array.isArray(runtimeModuleIds) &&
      runtimeModuleIds.every((id) => Number.isInteger(id))
    );
  }
  return false;
}

const sha256 = (body) => `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;

/**
 * The CSP hash sources of a page's own inline scripts, in page order, without repeats, and how many of Next's scripts
 * were left out past `MAX_SCRIPT_HASHES`.
 */
export function inlineScriptHashes(html) {
  const hashes = new Set();
  let dropped = 0;
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const [, attrs, body] = m;
    if (!isNextInlineScript(body, attrs.includes('id="_R_"'))) continue;
    const hash = sha256(body);
    if (hashes.has(hash)) continue;
    if (hashes.size >= MAX_SCRIPT_HASHES) dropped += 1;
    else hashes.add(hash);
  }
  return { hashes: [...hashes], dropped };
}

/** The script policy of a stored page's HTML (its `script-src` and where reports go). */
export function storedPageScriptPolicy(html, dev = false) {
  const { hashes, dropped } = inlineScriptHashes(html);
  return { policy: `${hashedScriptSrc(hashes, dev)}; ${CSP_REPORT_DIRECTIVE}`, dropped };
}

export const CSP_HEADER = 'content-security-policy';

/**
 * Adds the stored page's script policy to a page cache entry's headers, in place (Next serves the first answer from
 * the same headers object it stores). Only HTML page entries (`APP_PAGE` with a string `html`); others are untouched.
 */
export function withStoredPageScriptPolicy(data, { dev = false, onCapped } = {}) {
  if (!data || typeof data !== 'object' || data.kind !== 'APP_PAGE' || typeof data.html !== 'string') return data;
  const { policy, dropped } = storedPageScriptPolicy(data.html, dev);
  if (dropped > 0) onCapped?.(dropped);
  data.headers ??= {};
  data.headers[CSP_HEADER] = policy;
  return data;
}
