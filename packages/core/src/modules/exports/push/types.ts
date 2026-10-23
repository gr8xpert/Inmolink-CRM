/**
 * Push-style portal adapters (S9-04, PLAN §3 #19): idealista and Fotocasa take listings through partner APIs, not
 * feed files. An adapter is data plus three calls — the credential spec, a pure mapping of our client-safe listing to
 * the portal's payload, and publish / update / withdraw over a `PortalHttp` (a client that goes through `safeFetch`).
 * Everything that is not portal-specific — selection, validation, change detection, fair share, retries — is the push
 * engine's (`engine.ts`), shared by every adapter.
 *
 * H6 (partner access) has not arrived: both adapters follow what is publicly known and ASSUME the rest (see the
 * adapter files). They stay behind `exports.portal.<code>` until a sandbox run succeeds.
 */
import type { FeedItem } from '../../../feed-xml';
import type { PortalProfile } from '../profiles';

/** Whether an error concerns one listing's payload or the whole connection. */
export type PushErrorScope = 'LISTING' | 'CONNECTION';

/**
 * A failed portal call. `scope` CONNECTION: the whole connection is affected (credentials refused, portal down, rate
 * limited) — the run stops and, if `retryable`, the job retries later. `scope` LISTING: this payload was refused by
 * the portal — recorded as FAILED for the listing and not sent again until its content changes. `code` is a short
 * stable word (stored, max 40 characters), never the portal's text: nothing from a response body reaches a log or a
 * column.
 */
export class PortalPushError extends Error {
  override readonly name = 'PortalPushError';
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly scope: PushErrorScope,
    readonly retryAfterMs?: number,
  ) {
    super(`portal push: ${code}`);
  }
}

export interface PortalCredentialSpec {
  /** Keys a connection stores (a subset of the channel's `credentialFields`). */
  fields: readonly string[];
  /** Keys the adapter cannot work without. */
  required: readonly string[];
}

export interface PortalResponse {
  status: number;
  /** Parsed JSON body, or null (empty / not JSON). Never logged. */
  json: unknown;
}

/** The HTTP the adapters use: authenticated, classified (`PortalPushError`), SSRF-safe. */
export interface PortalHttp {
  request(method: 'PUT' | 'POST' | 'PATCH' | 'DELETE' | 'GET', path: string, body?: unknown): Promise<PortalResponse>;
}

export interface PortalAdapter {
  code: string;
  credentials: PortalCredentialSpec;
  /** Thresholds a listing must meet before it is sent (the shared validator, `validate.ts`). */
  profile: PortalProfile;
  /** Pure: the portal's payload for a listing. Same input, same output (it is hashed to detect changes). */
  mapListing(item: FeedItem, locale: string): unknown;
  /** Creates the advert; returns the portal's id for it. */
  publish(http: PortalHttp, ref: string, payload: unknown): Promise<{ remoteId: string }>;
  /** Replaces the advert; a `NOT_FOUND` error means the portal no longer has it (the engine publishes again). */
  update(http: PortalHttp, remoteId: string, payload: unknown): Promise<{ remoteId: string }>;
  /** Takes the advert down. An advert the portal no longer has is not an error. */
  withdraw(http: PortalHttp, remoteId: string): Promise<void>;
}

/** Maps an HTTP status to the engine's classification; null: success. */
export function classifyStatus(status: number, retryAfterMs?: number): PortalPushError | null {
  if (status >= 200 && status < 300) return null;
  // A redirect from a partner API means the base URL is wrong (writes never follow it).
  if (status >= 300 && status < 400) return new PortalPushError('NOT_CONFIGURED', false, 'CONNECTION');
  if (status === 401 || status === 403) return new PortalPushError('AUTH_REJECTED', false, 'CONNECTION');
  if (status === 404) return new PortalPushError('NOT_FOUND', false, 'LISTING');
  if (status === 408 || status === 425) return new PortalPushError('TIMEOUT', true, 'CONNECTION');
  if (status === 429) return new PortalPushError('RATE_LIMITED', true, 'CONNECTION', retryAfterMs);
  if (status >= 500) return new PortalPushError('PORTAL_ERROR', true, 'CONNECTION', retryAfterMs);
  return new PortalPushError('REJECTED', false, 'LISTING');
}
