import { type OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { FALLBACK_PAGE_CSP } from '../../script-policy.mjs';

/**
 * S16-F8 (security review): the last line of the portal's script policy. A page answer gets its `script-src` from the
 * proxy (pages rendered per request) or from its stored ISR copy (`cache-handler.mjs`); an HTML answer that has none
 * by the time its headers go out — an error page, a render Next did not store, a future Next change — gets
 * `FALLBACK_PAGE_CSP` (no inline script runs; the page shows, unhydrated). Only then: a second policy next to a stored
 * one would refuse the page's hashed scripts (browsers apply every policy).
 */

const CSP = 'content-security-policy';
const SCRIPT_SRC = /(?:^|[;,])\s*script-src\s/i;

const values = (v: unknown): string[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];

/** The fallback policy an answer needs: only HTML without any `script-src`, else null. */
export function fallbackPolicyFor(contentType: unknown, policies: readonly string[]): string | null {
  if (!/^\s*text\/html\b/i.test(values(contentType)[0] ?? '')) return null;
  return policies.some((p) => SCRIPT_SRC.test(p)) ? null : FALLBACK_PAGE_CSP;
}

/** Headers handed to `writeHead` itself (an object, or a flat / nested array of names and values). */
function passedHeader(headers: unknown, name: string): string[] {
  if (!headers || typeof headers !== 'object') return [];
  if (Array.isArray(headers)) {
    const flat = (headers as unknown[]).flat() as unknown[];
    const out: string[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (String(flat[i]).toLowerCase() === name) out.push(String(flat[i + 1]));
    }
    return out;
  }
  for (const [k, v] of Object.entries(headers as OutgoingHttpHeaders)) if (k.toLowerCase() === name) return values(v);
  return [];
}

const INSTALLED = Symbol.for('@inmolink/app-public/script-fallback');

/** Wraps `ServerResponse#writeHead` (Node calls it for implicit heads too) once per process. */
export function installScriptPolicyFallback(proto: ServerResponse = ServerResponse.prototype): void {
  const target = proto as ServerResponse & { [INSTALLED]?: true };
  if (target[INSTALLED]) return;
  target[INSTALLED] = true;
  const original = proto.writeHead;
  proto.writeHead = function writeHead(this: ServerResponse, ...args: unknown[]) {
    try {
      const passed = args.find((a, i) => i > 0 && a !== null && typeof a === 'object');
      const contentType = [...passedHeader(passed, 'content-type'), ...values(this.getHeader('content-type'))];
      // A CSP handed to writeHead replaces the one set before (Node's merge); otherwise the set one goes out.
      const handed = passedHeader(passed, CSP);
      const policies = handed.length > 0 ? handed : values(this.getHeader(CSP));
      const fallback = fallbackPolicyFor(contentType[0], policies);
      if (fallback && !this.headersSent) {
        if (passed && !Array.isArray(passed)) {
          const object = passed as Record<string, unknown>;
          for (const k of Object.keys(object)) if (k.toLowerCase() === CSP) delete object[k];
          object[CSP] = [...policies, fallback];
        } else this.appendHeader(CSP, fallback);
      }
    } catch {
      // Never fails an answer: the headers go out as they were.
    }
    return (original as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as ServerResponse['writeHead'];
}
