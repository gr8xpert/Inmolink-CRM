import type { FeedListingInput } from '@inmolink/contracts';
import { safeFetch } from '@inmolink/platform/safe-fetch';
import { FEED_FETCH } from '../config';
import {
  type ConnectorContext,
  type FeedConnector,
  FeedHttpStatusError,
  type FeedRecord,
  type FeedSource,
  feedListingProblems,
  registerConnector,
} from '../connectors';
import { mapResalesProperty, type ResalesRecord, resalesSettings } from './mapping';

/**
 * The Resales Online connector (S6-06, [H13]): the agency's own WebAPI V6 `SearchProperties` credentials, the agency's
 * own listings only.
 *
 * Own-only by construction, in two layers:
 *  1. the request: `p_agency_filterid=1` (the agency's own properties, as the API documents it; whether a filter was widened in the agency's Resales account is not ours to know, hence layer 2). It is
 *     set here, not in the connection's URL or settings, and overrides anything the URL carries;
 *  2. the connector: a record whose `AgencyId` is not the connection's own agency id (or has none) is dropped by
 *     `map` (item error `NOT_OWN_LISTING`, no ref, no content), so it is counted in the run report and never imported.
 *
 * Credentials are a `basic` credential: user name = the API identifier (`p1`), password = the API key (`p2`). They
 * travel as query parameters (what the API takes), only over https, only to `*.resales-online.com`, and with no
 * redirects followed, so a redirect cannot carry them elsewhere.
 */

export const RESALES_PAGE_SIZE = 40;
export const RESALES_MAX_PAGES = 1_000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const OWN_LISTINGS_FILTER = '1';

/** The connection cannot be used (no basic credentials, or a host that is not Resales Online): the run fails. */
export class ResalesConfigError extends Error {
  override readonly name = 'ResalesConfigError';
  constructor(readonly reason: 'CREDENTIALS_REQUIRED' | 'HOST_NOT_ALLOWED') {
    super(`the Resales Online connection is not usable: ${reason}`);
  }
}

/** The API answered but not with success (the message is the API's, never the credentials). */
export class ResalesApiError extends Error {
  override readonly name = 'ResalesApiError';
  constructor() {
    super('the Resales Online API did not return a success response');
  }
}

export interface ResalesPageRequest {
  url: string;
  signal: AbortSignal;
}
/** Fetches one result page: its JSON text. Replaced in tests. */
export type ResalesPageFetcher = (request: ResalesPageRequest) => Promise<string>;

const safePage: ResalesPageFetcher = async ({ url, signal }) => {
  const res = await safeFetch(url, {
    timeoutMs: 60_000,
    maxBytes: MAX_PAGE_BYTES,
    maxRedirects: 0,
    allowedContentTypes: ['application/json', 'text/json', 'text/plain'],
    signal,
  });
  if (!res.ok) {
    res.body.destroy();
    throw new FeedHttpStatusError(res.status);
  }
  return res.text();
};

const isResalesHost = (host: string) => host === 'resales-online.com' || host.endsWith('.resales-online.com');

/** The request URL of one page. Throws `ResalesConfigError` before anything is sent. */
export function resalesPageUrl(ctx: Pick<ConnectorContext, 'url' | 'credentials'>, page: number): string {
  if (ctx.credentials?.type !== 'basic') throw new ResalesConfigError('CREDENTIALS_REQUIRED');
  const u = new URL(ctx.url);
  if (u.protocol !== 'https:' || !isResalesHost(u.hostname.toLowerCase()))
    throw new ResalesConfigError('HOST_NOT_ALLOWED');
  // Whatever the stored URL carries, the request is built here: own listings, our paging, the credentials.
  u.search = '';
  u.searchParams.set('p1', ctx.credentials.username);
  u.searchParams.set('p2', ctx.credentials.password);
  u.searchParams.set('p_agency_filterid', OWN_LISTINGS_FILTER);
  u.searchParams.set('p_PageNo', String(page));
  u.searchParams.set('p_PageSize', String(RESALES_PAGE_SIZE));
  return u.href;
}

interface ResalesPage {
  transaction?: { status?: unknown };
  QueryInfo?: { PropertyCount?: unknown };
  Property?: unknown;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function createResalesConnector(
  fetchPage: ResalesPageFetcher,
  key = 'resales-online',
): FeedConnector<ResalesRecord, FeedListingInput> {
  const ownerOf = (ctx: ConnectorContext) =>
    resalesSettings(ctx.settings, ctx.credentials?.type === 'basic' ? ctx.credentials.username : '');
  return {
    key,
    async fetch(ctx): Promise<FeedSource> {
      resalesPageUrl(ctx, 1); // fail before the run starts
      let bytes = 0;
      let fetched = 0;
      let firstRef: string | undefined;
      async function* pages(): AsyncGenerator<Uint8Array> {
        for (let page = 1; page <= RESALES_MAX_PAGES; page++) {
          const text = await fetchPage({ url: resalesPageUrl(ctx, page), signal: ctx.signal });
          const chunk = Buffer.from(text);
          bytes += chunk.length;
          if (bytes > FEED_FETCH.MAX_BYTES) throw new ResalesApiError();
          yield chunk; // one whole JSON document per chunk
          let doc: ResalesPage | null = null;
          try {
            doc = asObject(JSON.parse(text)) as ResalesPage | null;
          } catch {
            return; // parse() reports it
          }
          const got = Array.isArray(doc?.Property) ? doc.Property.length : 0;
          const total = Number(doc?.QueryInfo?.PropertyCount);
          fetched += got;
          const first = Array.isArray(doc?.Property) ? asObject(doc.Property[0])?.Reference : undefined;
          // An API that ignores the page number would repeat page 1: stop instead of paging for ever.
          if (page > 1 && first !== undefined && String(first) === firstRef) throw new ResalesApiError();
          if (page === 1) firstRef = first === undefined ? undefined : String(first);
          if (got === 0 || (Number.isFinite(total) && fetched >= total)) return;
        }
        throw new ResalesApiError(); // cut off at the page cap: failing keeps the missing tail from being withdrawn
      }
      return { body: pages(), bytesRead: () => bytes, contentType: 'application/json' };
    },
    async *parse(source): AsyncGenerator<FeedRecord<ResalesRecord>> {
      let position = 0;
      for await (const chunk of source.body) {
        let doc: ResalesPage | null;
        try {
          doc = asObject(JSON.parse(Buffer.from(chunk).toString('utf8'))) as ResalesPage | null;
        } catch {
          throw new ResalesApiError();
        }
        if (!doc || asObject(doc.transaction)?.status !== 'success') throw new ResalesApiError();
        const items = Array.isArray(doc.Property) ? doc.Property : [];
        for (const raw of items) {
          const record = asObject(raw);
          // A non-object entry still takes a position (and fails in map as not own).
          yield { position: position++, raw: record ?? {} };
        }
      }
    },
    map: (raw, ctx) => mapResalesProperty(raw, ownerOf(ctx)),
    validate: (item) => feedListingProblems(item),
  };
}

export const resalesConnector = createResalesConnector(safePage);

registerConnector(resalesConnector);
