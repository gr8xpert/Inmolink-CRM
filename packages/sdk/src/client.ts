/**
 * Website API v2 client (S7-03, PLAN §9.5): one typed method per operation (`website-v2.generated.ts`, from feed-api's
 * OpenAPI by `pnpm sdk:generate`). Secret keys server-side (WordPress), publishable keys in browsers (the origin must
 * be on the key's allowlist). List values are sent comma-separated; errors throw `WebsiteApiError` with the API's code.
 */
import { bindOperations, type CallArgs, OPERATIONS, type OperationName, type Operations } from './website-v2.generated';

export interface WebsiteClientOptions {
  /** The API origin, e.g. `https://feed.inmolink.es`. */
  baseUrl: string;
  apiKey: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * The page's origin as the browser sends it in `Origin` (publishable keys). Defaults to `location.origin` in a
   * browser and none on a server. It goes into the edge-cache token `_k` (S7-06).
   */
  origin?: string;
}

/**
 * The edge-cache token (S7-06): base64url(SHA-256(`<api key>\n<origin or empty>`)), 22 characters, sent as `_k` on
 * every read so the website API's answers can be served from the CDN — cached URLs differ per key and origin. Clients
 * without the SDK (the WordPress plugin) compute the same value.
 */
export async function edgeKeyToken(apiKey: string, origin = ''): Promise<string> {
  const data = new TextEncoder().encode(`${apiKey}\n${origin}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}

const pageOrigin = (): string | undefined => (globalThis as { location?: { origin?: string } }).location?.origin;

/** An error answer of the website API (`{ error: { code, message, details } }`). */
export class WebsiteApiError extends Error {
  override readonly name = 'WebsiteApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${status} ${code}`);
  }
}

/** A query value as the API reads it: lists comma-separated, numbers and booleans as text. */
function queryString(query: Record<string, unknown> | undefined): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    params.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** `/v2/listings/{ref}` with `ref` filled in (encoded). */
function pathOf(template: string, params: Record<string, unknown> | undefined): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null) throw new TypeError(`missing path parameter: ${name}`);
    return encodeURIComponent(String(value));
  });
}

export function createWebsiteClient(options: WebsiteClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  let token: Promise<string> | undefined;
  async function call<K extends OperationName>(op: K, args: CallArgs<K>): Promise<Operations[K]['response']> {
    const { method, path } = OPERATIONS[op];
    // Reads carry the edge-cache token (S7-06); form posts do not need it.
    const query = args.query as Record<string, unknown> | undefined;
    if (method === 'GET') {
      token ??= edgeKeyToken(options.apiKey, options.origin ?? pageOrigin() ?? '');
    }
    const withToken = method === 'GET' ? { ...query, _k: await token } : query;
    const url = `${base}${pathOf(path, args.params as Record<string, unknown>)}${queryString(withToken)}`;
    const headers: Record<string, string> = {
      ...((args.headers as Record<string, string> | undefined) ?? {}),
      'x-api-key': options.apiKey,
      accept: 'application/json',
    };
    // Website forms (S7-05): a JSON body, with its `idempotency-key` header.
    if (args.body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(url, {
      method,
      headers,
      ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; details?: Record<string, unknown> };
      } | null;
      throw new WebsiteApiError(res.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.details);
    }
    return (await res.json()) as Operations[K]['response'];
  }
  return { call, ...bindOperations(call) };
}

export type WebsiteClient = ReturnType<typeof createWebsiteClient>;
