import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FALLBACK_PAGE_CSP, PAGE_BASE_CSP } from '../../script-policy.mjs';
import { fallbackPolicyFor, installScriptPolicyFallback } from './script-fallback';

const STORED = "script-src 'self' https://challenges.cloudflare.com 'sha256-AAAA'; report-uri /api/csp-report";

/** A real HTTP server: each path answers the way one Next code path does. */
const answers: Record<string, (res: ServerResponse) => void> = {
  // An error page / unstored render: HTML with only the base policy (next.config or the proxy).
  '/error': (res) => {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-security-policy', PAGE_BASE_CSP);
    res.end('<html><script>self.__next_f.push([0])</script></html>');
  },
  // An ISR copy: the proxy's base policy plus the stored one (appended by Next) — no fallback may join them.
  '/stored': (res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-security-policy', PAGE_BASE_CSP);
    res.appendHeader('content-security-policy', STORED);
    res.end('<html></html>');
  },
  // A per-request page: one policy with its nonce.
  '/nonce': (res) => {
    res.setHeader('content-type', 'text/html');
    res.setHeader('content-security-policy', `${PAGE_BASE_CSP}; script-src 'self' 'nonce-x'`);
    res.end('<html></html>');
  },
  // Headers handed to writeHead itself, no CSP at all.
  '/write-head': (res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html></html>');
  },
  '/json': (res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  },
};

let base = '';
const server = createServer((req: IncomingMessage, res: ServerResponse) => answers[req.url ?? '']?.(res));

beforeAll(async () => {
  installScriptPolicyFallback();
  installScriptPolicyFallback(); // once per process, however often it is asked
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The CSP header lines of an answer (each a policy). */
async function policies(path: string): Promise<string[]> {
  const res = await fetch(`${base}${path}`);
  await res.text();
  return (res.headers.get('content-security-policy') ?? '').split(/,\s*/).filter(Boolean);
}

describe('script policy fallback (S16-F8 review)', () => {
  it('[S16-F8] an HTML answer without any script-src (error page, unstored render) leaves with the no-inline fallback', async () => {
    expect(await policies('/error')).toEqual([PAGE_BASE_CSP, FALLBACK_PAGE_CSP]);
    expect(await policies('/write-head')).toEqual([FALLBACK_PAGE_CSP]);
    expect(FALLBACK_PAGE_CSP).toMatch(/script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
    expect(FALLBACK_PAGE_CSP).not.toMatch(/unsafe-inline|nonce|sha256/);
  });

  it('[S16-F8] an answer that has its own script-src (stored hashes, a nonce) never gets the fallback next to it', async () => {
    expect(await policies('/stored')).toEqual([PAGE_BASE_CSP, STORED]);
    expect(await policies('/nonce')).toEqual([`${PAGE_BASE_CSP}; script-src 'self' 'nonce-x'`]);
    expect(await policies('/json')).toEqual([]);
    expect(fallbackPolicyFor('text/html', [PAGE_BASE_CSP])).toBe(FALLBACK_PAGE_CSP);
    expect(fallbackPolicyFor('text/x-component', [])).toBeNull();
    expect(fallbackPolicyFor(undefined, [])).toBeNull();
    expect(fallbackPolicyFor(['text/html'], [`${PAGE_BASE_CSP}, ${STORED}`])).toBeNull();
  });
});
