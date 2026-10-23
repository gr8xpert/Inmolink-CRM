/**
 * The sandbox-capable HTTP client of push portals (S9-04). Every request goes through `platform/safe-fetch` (DNS
 * pinned to public addresses, no redirects for writes, size and time caps) and carries an OAuth2 client-credentials
 * bearer token fetched from the portal's token URL. The credentials are decrypted by the engine in the worker, handed
 * to this client in memory and never logged; responses are parsed as JSON but never logged or stored. Sandbox or
 * production is only the base URL: configuration (`configurePortalPush`), not code.
 */
import { SafeFetchError, type SafeFetchOptions, safeFetch } from '@inmolink/platform/safe-fetch';
import { classifyStatus, type PortalHttp, PortalPushError, type PortalResponse } from './types';

export interface PortalEndpoints {
  /** Base URL of the portal's partner API (sandbox or production), without a trailing slash. */
  apiBase: string;
  /** The OAuth2 token URL (client credentials). */
  tokenUrl: string;
}

export interface PortalHttpOptions {
  endpoints: PortalEndpoints;
  clientId: string;
  clientSecret: string;
  signal?: AbortSignal;
  /** Tests inject a resolver. */
  fetchOptions?: Pick<SafeFetchOptions, 'resolver'>;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RETRY_AFTER_MS = 15 * 60_000;

function retryAfter(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

const networkError = (err: unknown) =>
  err instanceof SafeFetchError && (err.code === 'BLOCKED_DESTINATION' || err.code === 'INVALID_URL')
    ? new PortalPushError('DESTINATION_BLOCKED', false, 'CONNECTION')
    : new PortalPushError('NETWORK', true, 'CONNECTION');

export class OAuthPortalHttp implements PortalHttp {
  #token: string | undefined;

  constructor(private readonly o: PortalHttpOptions) {}

  async #send(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; json: unknown; retryAfterMs?: number }> {
    try {
      const res = await safeFetch(url, {
        method,
        headers,
        body,
        signal: this.o.signal,
        timeoutMs: this.o.timeoutMs ?? 20_000,
        maxBytes: MAX_RESPONSE_BYTES,
        ...this.o.fetchOptions,
      });
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json, retryAfterMs: retryAfter(res.headers['retry-after']) };
    } catch (err) {
      throw networkError(err);
    }
  }

  async #authenticate(): Promise<string> {
    // RFC 6749 2.3.1: the id and secret are form-URL-encoded before they are joined and base64-encoded.
    const formEncode = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
    const basic = Buffer.from(`${formEncode(this.o.clientId)}:${formEncode(this.o.clientSecret)}`).toString('base64');
    const res = await this.#send(
      'POST',
      this.o.endpoints.tokenUrl,
      {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      'grant_type=client_credentials&scope=write',
    );
    const token = (res.json as { access_token?: unknown } | null)?.access_token;
    if (res.status >= 200 && res.status < 300 && typeof token === 'string' && token.length > 0) {
      this.#token = token;
      return token;
    }
    // A refused client id / secret is the connection's problem, never retried; a token endpoint that is down is.
    const failure = classifyStatus(res.status, res.retryAfterMs);
    throw failure?.retryable ? failure : new PortalPushError('AUTH_REJECTED', false, 'CONNECTION');
  }

  async request(
    method: 'PUT' | 'POST' | 'PATCH' | 'DELETE' | 'GET',
    path: string,
    body?: unknown,
  ): Promise<PortalResponse> {
    const url = `${this.o.endpoints.apiBase.replace(/\/+$/, '')}${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      const token = this.#token ?? (await this.#authenticate());
      const res = await this.#send(
        method,
        url,
        {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        payload,
      );
      // An expired token: one fresh token, then the call again.
      if (res.status === 401 && attempt === 0) {
        this.#token = undefined;
        continue;
      }
      const failure = classifyStatus(res.status, res.retryAfterMs);
      if (failure) throw failure;
      return { status: res.status, json: res.json };
    }
  }
}
