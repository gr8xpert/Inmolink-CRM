import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowLoopbackOriginsForTests, checkUrl, type Resolver, SafeFetchError, safeFetch } from './index';

/**
 * safeFetch against a local fixture server. The server listens on 127.0.0.1, which safeFetch refuses unless the
 * test opens exactly its origin (`allowLoopbackOriginsForTests`); public host names are answered by an injected
 * resolver, so no test touches real DNS or the internet.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let other: Server;
let origin: string;
let otherOrigin: string;
let undo: () => void;
const routes = new Map<string, Handler>();
const seen: { path: string; authorization?: string; host?: string }[] = [];
const otherSeen: { authorization?: string; apiKey?: string | string[] }[] = [];

const listen = async (s: Server) => {
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization, host: req.headers.host });
    const handler = routes.get((req.url ?? '').split('?')[0] ?? '');
    if (handler) handler(req, res);
    else res.writeHead(404).end();
  });
  other = createServer((req, res) => {
    otherSeen.push({ authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] });
    res.writeHead(200, { 'content-type': 'text/plain' }).end('other');
  });
  origin = await listen(server);
  otherOrigin = await listen(other);
  undo = allowLoopbackOriginsForTests([origin]);
});

afterAll(async () => {
  undo();
  server.close();
  other.close();
});

const route = (path: string, handler: Handler) => routes.set(path, handler);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: unknown) => (err instanceof SafeFetchError ? err.code : `other: ${String(err)}`),
  );
/** A resolver that answers every name with `address` (the attacker controls DNS). */
const answering =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('safeFetch', () => {
  it('[S6-01] feed URLs that are private, loopback or metadata IP literals are refused before any connection', async () => {
    for (const url of [
      'http://127.0.0.1/feed.xml',
      'http://10.0.0.8/feed.xml',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00:ec2::254]/',
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/', // 127.0.0.1 as a decimal (the URL parser normalises it)
      'http://0x7f.1/',
      'http://localhost/',
      'http://metadata.google.internal/computeMetadata/v1/',
      `${otherOrigin}/`, // loopback, but not the origin the test opened
    ]) {
      expect(await code(safeFetch(url, { resolver: answering('93.184.216.34') })), url).toBe('BLOCKED_DESTINATION');
    }
  });

  it('[S6-01] a host name whose DNS answer is private, loopback or metadata is refused (also a mixed answer)', async () => {
    for (const answer of [
      ['10.1.2.3'],
      ['127.0.0.1'],
      ['169.254.169.254'],
      ['::1'],
      ['93.184.216.34', '192.168.0.10'],
    ]) {
      expect(
        await code(safeFetch('https://feeds.example.com/kyero.xml', { resolver: answering(...answer) })),
        answer.join(),
      ).toBe('BLOCKED_DESTINATION');
    }
  });

  it('[S6-01] a redirect to a private, metadata or other loopback address is refused at that hop', async () => {
    route('/to-metadata', (_req, res) => res.writeHead(302, { location: 'http://169.254.169.254/latest/' }).end());
    route('/to-other-port', (_req, res) => res.writeHead(301, { location: `${otherOrigin}/` }).end());
    route('/to-private-name', (_req, res) => res.writeHead(307, { location: 'http://intranet.example.com/x' }).end());
    route('/to-mapped', (_req, res) => res.writeHead(308, { location: 'http://[::ffff:10.0.0.1]/' }).end());
    route('/to-file', (_req, res) => res.writeHead(302, { location: 'file:///etc/passwd' }).end());
    const resolver = answering('10.0.0.7');
    expect(await code(safeFetch(`${origin}/to-metadata`, { resolver }))).toBe('BLOCKED_DESTINATION');
    expect(await code(safeFetch(`${origin}/to-other-port`, { resolver }))).toBe('BLOCKED_DESTINATION');
    expect(await code(safeFetch(`${origin}/to-private-name`, { resolver }))).toBe('BLOCKED_DESTINATION');
    expect(await code(safeFetch(`${origin}/to-mapped`, { resolver }))).toBe('BLOCKED_DESTINATION');
    expect(await code(safeFetch(`${origin}/to-file`, { resolver }))).toBe('BLOCKED_DESTINATION');
  });

  it('[S6-01] follows allowed redirects up to the cap and keeps credentials on the same origin only', async () => {
    route('/hop', (req, res) => {
      const n = Number(new URL(req.url ?? '', origin).searchParams.get('n'));
      if (n > 0) res.writeHead(302, { location: `/hop?n=${n - 1}` }).end();
      else res.writeHead(200, { 'content-type': 'application/xml' }).end('<ok/>');
    });
    const ok = await safeFetch(`${origin}/hop?n=3`, { headers: { Authorization: 'Basic c2VjcmV0' } });
    expect(await ok.text()).toBe('<ok/>');
    expect(ok.url).toBe(`${origin}/hop?n=0`);
    expect(seen.filter((s) => s.path.startsWith('/hop')).every((s) => s.authorization === 'Basic c2VjcmV0')).toBe(true);
    expect(await code(safeFetch(`${origin}/hop?n=6`))).toBe('TOO_MANY_REDIRECTS');
    expect(await code(safeFetch(`${origin}/hop?n=2`, { maxRedirects: 1 }))).toBe('TOO_MANY_REDIRECTS');
  });

  it('[S6-01] a name answering loopback is refused even while the loopback origin is open (DNS asked once)', async () => {
    let lookups = 0;
    const port = new URL(origin).port;
    const undoName = allowLoopbackOriginsForTests([origin]);
    route('/named', (_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('hi'));
    // A public name whose answer is loopback stays refused even while the loopback origin is open.
    const resolver: Resolver = async () => {
      lookups++;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    expect(
      await code(safeFetch(`http://feeds.example.com:${port}/named`, { resolver, allowedPorts: [Number(port)] })),
    ).toBe('BLOCKED_DESTINATION');
    expect(lookups).toBe(1);
    undoName();
  });

  it('[S6-01] a redirect to another origin never carries the caller headers (credentials)', async () => {
    const undoOther = allowLoopbackOriginsForTests([otherOrigin]);
    route('/cross', (_req, res) => res.writeHead(302, { location: `${otherOrigin}/landing` }).end());
    const res = await safeFetch(`${origin}/cross`, {
      headers: { authorization: 'Basic c2VjcmV0', 'X-Api-Key': 'k-123' },
    });
    expect(await res.text()).toBe('other');
    expect(otherSeen.at(-1)).toEqual({ authorization: undefined, apiKey: undefined });
    undoOther();
  });

  it('[S6-01] callers cannot set routing or framing headers; ports outside 80/443/8080/8443 are refused', async () => {
    for (const name of ['Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Cookie']) {
      expect(await code(safeFetch(`${origin}/hop?n=0`, { headers: { [name]: 'x' } })), name).toBe('INVALID_REQUEST');
    }
    const injected = { 'x-k': 'a\r\nHost: evil' };
    expect(await code(safeFetch(`${origin}/hop?n=0`, { headers: injected }))).toBe('INVALID_REQUEST');
    const resolver = answering('93.184.216.34');
    for (const url of [
      'http://feeds.example.com:22/',
      'https://feeds.example.com:6379/',
      'http://feeds.example.com:25/',
    ]) {
      expect(await code(safeFetch(url, { resolver })), url).toBe('BLOCKED_DESTINATION');
    }
    expect(checkUrl('https://feeds.example.com:8443/x').port).toBe('8443');
  });

  it('[S6-01] only http and https, never credentials in the URL', () => {
    expect(() => checkUrl('ftp://feeds.example.com/x')).toThrow(SafeFetchError);
    expect(() => checkUrl('gopher://feeds.example.com/x')).toThrow(SafeFetchError);
    expect(() => checkUrl('https://user:pass@feeds.example.com/x')).toThrow(SafeFetchError);
    expect(() => checkUrl('not a url')).toThrow(SafeFetchError);
    expect(checkUrl('https://feeds.example.com/x.xml').hostname).toBe('feeds.example.com');
  });

  it('[S6-01] refuses a declared content length over the cap, and a body over the cap when the length lies', async () => {
    route('/big-declared', (_req, res) =>
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': '5000' }).end('x'.repeat(5000)),
    );
    route('/big-chunked', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('x'.repeat(5000));
    });
    route('/gzip-bomb', (_req, res) =>
      res
        .writeHead(200, { 'content-type': 'application/xml', 'content-encoding': 'gzip' })
        .end(gzipSync(Buffer.alloc(200_000, 0x20))),
    );
    expect(await code(safeFetch(`${origin}/big-declared`, { maxBytes: 1000 }))).toBe('TOO_LARGE');
    const chunked = await safeFetch(`${origin}/big-chunked`, { maxBytes: 1000 });
    expect(await code(chunked.text())).toBe('TOO_LARGE');
    const bomb = await safeFetch(`${origin}/gzip-bomb`, { maxBytes: 10_000 });
    expect(await code(bomb.text())).toBe('TOO_LARGE');
  });

  it('[S6-01] content types outside the allow-list are refused', async () => {
    route('/html', (_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html/>'));
    route('/xml', (_req, res) => res.writeHead(200, { 'content-type': 'Text/XML; charset=iso-8859-1' }).end('<a/>'));
    const allowedContentTypes = ['application/xml', 'text/xml'];
    expect(await code(safeFetch(`${origin}/html`, { allowedContentTypes }))).toBe('CONTENT_TYPE');
    const xml = await safeFetch(`${origin}/xml`, { allowedContentTypes });
    expect(xml.contentType).toBe('text/xml');
    expect(await xml.text()).toBe('<a/>');
  });

  it('[S6-01] a slow server times out (deadline over headers and body)', async () => {
    route('/slow-headers', () => {
      /* never answers */
    });
    route('/slow-body', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.write('<a>');
      // never ends
    });
    expect(await code(safeFetch(`${origin}/slow-headers`, { timeoutMs: 200 }))).toBe('TIMEOUT');
    const slow = await safeFetch(`${origin}/slow-body`, { timeoutMs: 300 });
    expect(await code(slow.text())).toBe('TIMEOUT');
  });

  it('streams the body and decompresses gzip', async () => {
    route('/gz', (_req, res) =>
      res
        .writeHead(200, { 'content-type': 'application/xml', 'content-encoding': 'gzip' })
        .end(gzipSync('<feed>hello</feed>')),
    );
    const res = await safeFetch(`${origin}/gz`);
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('<feed>hello</feed>');
    expect(res.bytesRead()).toBe(18);
  });

  it('[S6-01] the test escape hatch accepts loopback origins only', () => {
    expect(() => allowLoopbackOriginsForTests(['http://10.0.0.1:80'])).toThrow();
    expect(() => allowLoopbackOriginsForTests(['http://example.com'])).toThrow();
  });

  it('[S7-F1] the test escape hatch refuses NODE_ENV=production even when VITEST is set', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(process.env.VITEST).toBe('true');
      expect(() => allowLoopbackOriginsForTests(['http://127.0.0.1:9'])).toThrow(/refused in production/);
      // an origin allowed earlier stops counting the moment the process says production
      expect(() => checkUrl(`${origin}/feed.xml`)).toThrow(SafeFetchError);
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});
