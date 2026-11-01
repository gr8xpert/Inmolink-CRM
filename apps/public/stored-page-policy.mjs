// S16-F8 (security-R1.md M-3): the script policy of an ISR page as the page cache stores it (`cache-handler.mjs`).
// Plain ESM, Node only (hashing): Next loads the cache handler at runtime, uncompiled.
//
// Next renders ISR pages without the request's nonce, so a stored page's own inline scripts are allowed by their
// SHA-256 hashes. Only the shapes Next itself writes are hashed — the flight bootstrap, the flight data pushes (a JSON
// array, `<` escaped, so the content has no tag) and the Turbopack chunk bootstrap (`id="_R_"`, chunk paths and module
// ids only); anything else inline (no hash) is refused by the browser. JSON-LD (`type="application/ld+json"`) is data,
// not script: never hashed, never run.
//
// S17-F2 (S16 review, residual Medium): a flight data push is hashed only when the cache entry's own `rscData` (the RSC
// payload Next rendered for the page, which the inline pushes are a copy of) holds its string — `[1, text]` as UTF-8,
// `[3, base64]` decoded. A push that markup injected into the HTML (it has the right shape but data React never
// rendered) gets no hash; with no `rscData` no push is hashed (fail closed). The pushes must be the payload cut in
// page order (a cursor walks `rscData`), not just any substring of it.
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

/** The bytes a flight push carries (`[1, text]` → UTF-8, `[3, base64]` → decoded), or undefined for another shape. */
function flightPushBytes(body) {
  const v = parse(body.slice(FLIGHT_PUSH.length, -1));
  if (!Array.isArray(v) || v.length !== 2 || (v[0] !== 1 && v[0] !== 3) || typeof v[1] !== 'string') return undefined;
  return v[0] === 1 ? Buffer.from(v[1], 'utf8') : Buffer.from(v[1], 'base64');
}

const isFlightPush = (body) => body.startsWith(FLIGHT_PUSH) && body.endsWith(')');

/** The entry's RSC payload as a Buffer (no copy for bytes; a string is encoded), or undefined. */
function rscBytes(rscData) {
  if (typeof rscData === 'string') return Buffer.from(rscData, 'utf8');
  if (rscData instanceof Uint8Array) return Buffer.from(rscData.buffer, rscData.byteOffset, rscData.byteLength);
  return undefined;
}

/**
 * True for a script body of a shape Next writes into a page (see the header). A flight data push of the right shape
 * still needs its data checked against the entry's `rscData` (`inlineScriptHashes` does).
 */
export function isNextInlineScript(body, isTurbopackBootstrap) {
  if (body === FLIGHT_BOOTSTRAP) return true;
  if (isFlightPush(body)) return flightPushBytes(body) !== undefined;
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
 * were left out past `MAX_SCRIPT_HASHES` or refused as not the entry's (`unmatched`). `rscData`: the entry's RSC payload. Next's flight pushes are that payload
 * cut in order, so a push is hashed only when its bytes are the next ones of `rscData` (a cursor walks it): a push that
 * is merely a substring elsewhere — long text rows are written raw, so page text could carry copied rows — gets none.
 */
export function inlineScriptHashes(html, rscData) {
  const rsc = rscBytes(rscData);
  let cursor = 0;
  const hashes = new Set();
  let dropped = 0;
  let unmatched = 0;
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const [, attrs, body] = m;
    if (!isNextInlineScript(body, attrs.includes('id="_R_"'))) continue;
    if (isFlightPush(body)) {
      const bytes = flightPushBytes(body);
      if (!rsc || !bytes || bytes.length === 0 || !rsc.subarray(cursor, cursor + bytes.length).equals(bytes)) {
        unmatched += 1;
        continue;
      }
      cursor += bytes.length;
    }
    const hash = sha256(body);
    if (hashes.has(hash)) continue;
    if (hashes.size >= MAX_SCRIPT_HASHES) dropped += 1;
    else hashes.add(hash);
  }
  return { hashes: [...hashes], dropped, unmatched };
}

/** The script policy of a stored page's HTML and RSC payload (its `script-src` and where reports go). */
export function storedPageScriptPolicy(html, rscData, dev = false) {
  const { hashes, dropped, unmatched } = inlineScriptHashes(html, rscData);
  return { policy: `${hashedScriptSrc(hashes, dev)}; ${CSP_REPORT_DIRECTIVE}`, dropped, unmatched };
}

export const CSP_HEADER = 'content-security-policy';

/**
 * Adds the stored page's script policy to a page cache entry's headers, in place (Next serves the first answer from
 * the same headers object it stores). Only HTML page entries (`APP_PAGE` with a string `html`); others are untouched.
 * `onUnmatched(n, noRscData)`: flight pushes that got no hash (S17-F2).
 */
export function withStoredPageScriptPolicy(data, { dev = false, onCapped, onUnmatched } = {}) {
  if (!data || typeof data !== 'object' || data.kind !== 'APP_PAGE' || typeof data.html !== 'string') return data;
  const { policy, dropped, unmatched } = storedPageScriptPolicy(data.html, data.rscData, dev);
  if (dropped > 0) onCapped?.(dropped);
  // S17-F2: flight pushes refused as not the entry's (injected markup — or a Next change of the payload's shape, which
  // would block hydration on every stored page: the cache handler logs it)
  if (unmatched > 0) onUnmatched?.(unmatched, data.rscData === undefined);
  data.headers ??= {};
  data.headers[CSP_HEADER] = policy;
  return data;
}
