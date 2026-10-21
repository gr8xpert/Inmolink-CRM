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
}

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
  async function call<K extends OperationName>(op: K, args: CallArgs<K>): Promise<Operations[K]['response']> {
    const { method, path } = OPERATIONS[op];
    const url = `${base}${pathOf(path, args.params as Record<string, unknown>)}${queryString(args.query as Record<string, unknown>)}`;
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
