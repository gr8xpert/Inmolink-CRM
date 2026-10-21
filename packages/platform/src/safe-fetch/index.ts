import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { pipeline, type Readable, Transform, type TransformCallback } from 'node:stream';
import zlib from 'node:zlib';
import { classifyIp, type IpBlockReason, isBlockedHostname } from './ip';

/**
 * @inmolink/platform/safe-fetch — the only way to fetch a user-supplied URL (PLAN §3 #64, PATTERNS §16,
 * security.md): feeds, images, webhooks.
 *
 * - http/https only, no credentials in the URL, host names reserved for local use refused before DNS;
 * - DNS is resolved here and every answer must be public (`classifyIp`); the socket then connects to exactly
 *   the vetted addresses (custom `lookup`), so a second DNS answer cannot swap in a private one (no rebinding);
 * - redirects are followed by hand (≤ `maxRedirects`, default 5) and every hop is checked again; credentials
 *   (`authorization`, `cookie`) are dropped when a redirect leaves the origin;
 * - one deadline for the whole exchange (headers and body), an idle-socket timeout, a byte cap on the body
 *   (decompressed) whatever `content-length` says, and an allow-list of content types;
 * - the body is a stream: callers parse it as it arrives (100 MB+ feeds never sit in memory).
 */
export { classifyIp, expandIpv6, type IpBlockReason, type IpVerdict, isBlockedHostname } from './ip';

export type SafeFetchErrorCode =
  | 'INVALID_URL'
  | 'INVALID_REQUEST'
  | 'BLOCKED_DESTINATION'
  | 'DNS_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'CONTENT_TYPE'
  | 'NETWORK';

/** Messages name the rule, never the response body; `reason` says which block applied. */
export class SafeFetchError extends Error {
  override readonly name = 'SafeFetchError';
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly details: { reason?: IpBlockReason | 'hostname' | 'scheme' | 'credentials' | 'port'; status?: number } = {},
  ) {
    super(message);
  }
}

export function isSafeFetchError(err: unknown): err is SafeFetchError {
  return err instanceof SafeFetchError;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
/** Resolves a host name to all its addresses (tests inject answers; production uses the system resolver). */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  /** Request headers (e.g. `authorization` for a feed's credentials). Never logged. */
  headers?: Record<string, string>;
  /** Deadline for the whole exchange, body included. Default 30 s. */
  timeoutMs?: number;
  /** A socket silent this long fails the fetch. Default 15 s. */
  idleTimeoutMs?: number;
  /** Body cap in bytes after decompression. Default 10 MB. */
  maxBytes?: number;
  /** Default 5 (security.md), at most 10. */
  maxRedirects?: number;
  /** Ports allowed on every hop. Default 80, 443, 8080, 8443. */
  allowedPorts?: readonly number[];
  /**
   * Media types a successful (2xx) response may have — `type/subtype`, or `type/*`. A missing header is refused
   * unless `allowMissingContentType`. Omitted: any.
   */
  allowedContentTypes?: readonly string[];
  allowMissingContentType?: boolean;
  signal?: AbortSignal;
  resolver?: Resolver;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  /** Final URL after redirects. */
  url: string;
  headers: IncomingHttpHeaders;
  /** Lower-case media type without parameters, or null. */
  contentType: string | null;
  /** The (decompressed, byte-capped) body. Iterate it or pipe it; destroy it to stop early. */
  body: Readable;
  /** Body bytes delivered so far. */
  bytesRead(): number;
  /** Reads the whole body as UTF-8 (still capped by `maxBytes`) — for small responses only. */
  text(): Promise<string>;
}

const DEFAULTS = { timeoutMs: 30_000, idleTimeoutMs: 15_000, maxBytes: 10 * 1024 * 1024, maxRedirects: 5 };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_URL_LENGTH = 2_048;
/** Ports a fetch may connect to (security review: no feed-driven port scans of third-party hosts). */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443];
/**
 * Request headers a caller may not set: routing (`host`), framing and hop-by-hop headers, and the ones safeFetch
 * owns. A credential header named like one of these would redirect the request or corrupt it.
 */
export const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'connection',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
  'expect',
  'accept-encoding',
  'user-agent',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

// ── Test escape hatch ──────────────────────────────────────────────────────────────────────────────────────────

let testOrigins: ReadonlySet<string> = new Set();

/**
 * Tests only: lets `safeFetch` reach these exact loopback origins (`http://127.0.0.1:<port>`, a local fixture
 * server). There is no environment variable for it; it throws unless the process runs under Vitest and not in
 * production, and only loopback IP literals qualify. Returns the undo function.
 */
export function allowLoopbackOriginsForTests(origins: readonly string[]): () => void {
  // S7-F1 (S6 review L3): production refuses first and on its own, whatever else the environment says.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('allowLoopbackOriginsForTests is refused in production');
  }
  if (process.env.NODE_ENV !== 'test' || process.env.VITEST !== 'true') {
    throw new Error('allowLoopbackOriginsForTests is for tests only');
  }
  for (const origin of origins) {
    const u = new URL(origin);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.origin !== origin || (host !== '127.0.0.1' && host !== '::1')) {
      throw new Error(`allowLoopbackOriginsForTests: ${origin} is not a loopback origin`);
    }
  }
  const before = testOrigins;
  testOrigins = new Set([...before, ...origins]);
  return () => {
    testOrigins = before;
  };
}

/** True only for an origin a test allowed with `allowLoopbackOriginsForTests` (local http fixture servers). */
export function isTestOrigin(url: string | URL): boolean {
  // S7-F1: never in production, even if an allowance was somehow registered before NODE_ENV changed
  if (process.env.NODE_ENV === 'production') return false;
  return testOrigins.has(new URL(String(url)).origin);
}

// ── URL and destination checks ─────────────────────────────────────────────────────────────────────────────────

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

/**
 * Syntax-level check of a user-supplied URL, without DNS (services call it when a URL is saved, for an early
 * answer; `safeFetch` repeats it with DNS on every hop). Returns the parsed URL.
 */
export function checkUrl(input: string | URL, allowedPorts?: readonly number[]): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new SafeFetchError('INVALID_URL', 'not a valid absolute URL');
  }
  if (String(input).length > MAX_URL_LENGTH) throw new SafeFetchError('INVALID_URL', 'URL too long');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('BLOCKED_DESTINATION', 'only http and https are allowed', { reason: 'scheme' });
  }
  if (url.username || url.password) {
    throw new SafeFetchError('BLOCKED_DESTINATION', 'credentials in the URL are not allowed', {
      reason: 'credentials',
    });
  }
  if (isTestOrigin(url)) return url;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!(allowedPorts ?? DEFAULT_ALLOWED_PORTS).includes(port)) {
    throw new SafeFetchError('BLOCKED_DESTINATION', 'destination port is not allowed', { reason: 'port' });
  }
  const host = bare(url.hostname);
  if (isIP(host)) {
    const verdict = classifyIp(host);
    if (!verdict.allowed) {
      throw new SafeFetchError('BLOCKED_DESTINATION', 'destination address is not public', { reason: verdict.reason });
    }
  } else if (isBlockedHostname(host)) {
    throw new SafeFetchError('BLOCKED_DESTINATION', 'destination host is reserved for internal use', {
      reason: 'hostname',
    });
  }
  return url;
}

/** Resolves `url`'s host and returns the addresses to connect to — all public, or the fetch is refused. */
async function vet(url: URL, resolver: Resolver, allowedPorts?: readonly number[]): Promise<ResolvedAddress[]> {
  checkUrl(url, allowedPorts);
  const host = bare(url.hostname);
  const literal = isIP(host);
  if (literal) return [{ address: host, family: literal === 6 ? 6 : 4 }];
  let answers: ResolvedAddress[];
  try {
    answers = await resolver(host);
  } catch {
    throw new SafeFetchError('DNS_FAILED', 'the host name did not resolve');
  }
  if (answers.length === 0) throw new SafeFetchError('DNS_FAILED', 'the host name did not resolve');
  // Every answer must be public: a mixed answer would let the connection pick the private one.
  for (const a of answers) {
    const verdict = classifyIp(a.address);
    if (!verdict.allowed) {
      throw new SafeFetchError('BLOCKED_DESTINATION', 'the host name resolves to a non-public address', {
        reason: verdict.reason,
      });
    }
  }
  return answers;
}

/** Hands the socket exactly the vetted addresses: Node never resolves the name again. */
function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    const first = addresses[0] as ResolvedAddress;
    if (options?.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  }) as unknown as LookupFunction;
}

function mediaType(headers: IncomingHttpHeaders): string | null {
  const raw = headers['content-type'];
  if (!raw) return null;
  return (raw.split(';')[0] ?? '').trim().toLowerCase() || null;
}

function typeAllowed(type: string | null, options: SafeFetchOptions): boolean {
  const allowed = options.allowedContentTypes;
  if (!allowed) return true;
  if (type === null) return options.allowMissingContentType === true;
  return allowed.some((a) => {
    const rule = a.toLowerCase();
    return rule.endsWith('/*') ? type.startsWith(rule.slice(0, -1)) : type === rule;
  });
}

/** Counts bytes and fails the stream once `max` is passed (also when `content-length` understated the body). */
class ByteLimit extends Transform {
  count = 0;
  constructor(private readonly max: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.count += chunk.length;
    if (this.count > this.max) {
      done(new SafeFetchError('TOO_LARGE', `the response body exceeds ${this.max} bytes`));
      return;
    }
    done(null, chunk);
  }
}

function decoderFor(encoding: string | undefined): Transform | null {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    case '':
    case 'identity':
      return null;
    default:
      throw new SafeFetchError('CONTENT_TYPE', 'unsupported content encoding');
  }
}

interface Exchange {
  response: IncomingMessage;
  abort(err: Error): void;
}

function requestOnce(
  url: URL,
  addresses: ResolvedAddress[],
  headers: Record<string, string>,
  method: 'GET' | 'HEAD',
  idleTimeoutMs: number,
  signal: AbortSignal,
): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const host = bare(url.hostname);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'InmolinkBot/1.0', ...headers },
      agent: false, // no pooled socket from another (possibly differently vetted) request
      lookup: pinnedLookup(addresses),
      ...(isIP(host) ? {} : { servername: host }),
      maxHeaderSize: 32 * 1024,
      timeout: idleTimeoutMs,
      signal,
    });
    req.on('timeout', () => req.destroy(new SafeFetchError('TIMEOUT', 'the server stopped responding')));
    req.on('error', (err) => reject(err));
    req.on('response', (response) =>
      resolve({
        response,
        abort: (err) => {
          req.destroy(err);
          response.destroy(err);
        },
      }),
    );
    req.end();
  });
}

const asSafeError = (err: unknown): Error =>
  err instanceof SafeFetchError ? err : new SafeFetchError('NETWORK', 'the request failed');

/** Fetches a user-supplied URL with the SSRF, size and time limits above. See the module comment. */
export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = Math.min(options.maxRedirects ?? DEFAULTS.maxRedirects, 10);
  const resolver = options.resolver ?? systemResolver;
  const method = options.method ?? 'GET';
  let headers: Record<string, string> = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([k, v]) => {
      const name = k.toLowerCase();
      if (RESERVED_HEADERS.has(name) || !/^[a-z0-9-]{1,64}$/.test(name) || /[\r\n\0]/.test(v)) {
        throw new SafeFetchError('INVALID_REQUEST', `request header ${name.slice(0, 64)} may not be set`);
      }
      return [name, v];
    }),
  );

  let current: Exchange | undefined;
  let failure: Error | undefined;
  const controller = new AbortController();
  const fail = (err: Error) => {
    failure ??= err;
    current?.abort(failure);
    controller.abort(failure);
  };
  const deadline = setTimeout(() => fail(new SafeFetchError('TIMEOUT', 'the request took too long')), timeoutMs);
  const onAbort = () => fail(new SafeFetchError('TIMEOUT', 'the request was cancelled'));
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onAbort);
  };

  try {
    let url = checkUrl(input, options.allowedPorts);
    for (let hop = 0; ; hop++) {
      if (failure) throw failure;
      const addresses = await vet(url, resolver, options.allowedPorts);
      if (failure) throw failure;
      current = await requestOnce(
        url,
        addresses,
        headers,
        method,
        options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
        controller.signal,
      );
      if (failure) throw failure;
      const { response } = current;
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECTS.has(status) && location) {
        response.resume(); // discard the redirect's body
        current.abort(new Error('redirect'));
        if (hop >= maxRedirects) throw new SafeFetchError('TOO_MANY_REDIRECTS', `more than ${maxRedirects} redirects`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SafeFetchError('INVALID_URL', 'the redirect target is not a valid URL');
        }
        // Another origin never gets the caller's headers: they may carry credentials (Basic auth, API-key headers).
        if (next.origin !== url.origin) headers = {};
        url = next;
        continue;
      }

      const contentType = mediaType(response.headers);
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new SafeFetchError('TOO_LARGE', `the response body exceeds ${maxBytes} bytes`, { status });
      }
      const ok = status >= 200 && status < 300;
      if (ok && !typeAllowed(contentType, options)) {
        throw new SafeFetchError('CONTENT_TYPE', 'the response content type is not allowed', { status });
      }

      const limiter = new ByteLimit(maxBytes);
      const decoder = decoderFor(response.headers['content-encoding']);
      const exchange = current;
      exchange.abort = (err) => {
        response.destroy(err);
        limiter.destroy(err);
      };
      const done = (err: Error | null) => {
        cleanup();
        if (err) limiter.destroy(failure ?? asSafeError(err));
      };
      if (decoder) pipeline(response, decoder, limiter, done);
      else pipeline(response, limiter, done);

      return {
        status,
        ok,
        url: url.href,
        headers: response.headers,
        contentType,
        body: limiter,
        bytesRead: () => limiter.count,
        async text() {
          const chunks: Buffer[] = [];
          for await (const chunk of limiter) chunks.push(chunk as Buffer);
          return Buffer.concat(chunks).toString('utf8');
        },
      };
    }
  } catch (err) {
    cleanup();
    current?.abort(failure ?? asSafeError(err));
    throw failure ?? asSafeError(err);
  }
}
