import { type FeedCredentials, FeedListing, type FeedSettings } from '@inmolink/contracts';
import { type SafeFetchOptions, safeFetch } from '@inmolink/platform/safe-fetch';
import { streamXmlRecords, type XmlElement, type XmlStreamOptions } from '@inmolink/platform/xml';
import { FEED_FETCH } from './config';

/**
 * The connector framework (S6-01, PLAN §7 M5): every feed format is a connector that goes
 * `fetch → parse (stream) → map → validate`; the run pipeline (`pipeline.ts`) drives it, commits in batches and
 * records per-item errors. Connectors are pure format knowledge: no database, no tenant context — they get the
 * connection's URL, settings, mapping and decrypted credentials. The concrete connectors (Kyero, generic XML, CSV,
 * Resales Online, …) are S6-03+; they register here at module load (`registerConnector`).
 */

/** What a connector sees of the connection it runs for. */
export interface ConnectorContext {
  connectionId: string;
  agencyId: string;
  url: string;
  settings: FeedSettings;
  /** The mapping profile's mapping (generic XML), or null. */
  mapping: unknown;
  /** Decrypted — never log it. */
  credentials: FeedCredentials | null;
  signal: AbortSignal;
  /**
   * S6-F4: the stored source hashes of the connection (only for a connector with `sourceHashes`): refs → hash of the
   * record as last fetched in full, for refs checked recently. Opens its own short transaction; never inside one.
   */
  sourceHashes?: (refs: readonly string[]) => Promise<Map<string, string>>;
}

/** The fetched feed: a byte stream (never the whole document in memory). */
export interface FeedSource {
  body: AsyncIterable<Uint8Array>;
  /** Bytes read so far (for the run's `bytes_read`). */
  bytesRead(): number;
  contentType: string | null;
  /** S6-F4: connector counters for the run log (counts only, never feed content). */
  stats?(): Record<string, number>;
}

/** One record as the parser produced it, with its 0-based position in the feed. */
export interface FeedRecord<Raw> {
  position: number;
  raw: Raw;
}

/** A problem with one item; `code` is UPPER_SNAKE (`MISSING_FIELD`, `INVALID_PRICE`, …). */
export interface FeedItemProblem {
  code: string;
  field?: string;
  /** Short, no credentials; feed content only as far as needed to find the item. */
  message?: string;
}

export type MapResult<Item> =
  /** `sourceHash` (S6-F4): stored for the ref once the loader stored the item (connectors with `sourceHashes`). */
  | { ok: true; ref: string; item: Item; sourceHash?: string }
  /**
   * `seen` (S6-F4): the item is in the feed and unchanged since it was last stored — counted as present (never
   * withdrawn), not written, not an error. `problems` is then empty.
   */
  | { ok: false; ref?: string; problems: FeedItemProblem[]; seen?: boolean };

export interface FeedConnector<Raw = unknown, Item = unknown> {
  /** Registry key, stored on the connection (`kyero`, `generic-xml`). */
  key: string;
  /** The connection needs a mapping profile (generic XML): creating one without is refused. */
  requiresMapping?: boolean;
  /** S6-F4: the connector reads and reports source hashes (`ConnectorContext.sourceHashes`, `MapResult.sourceHash`). */
  sourceHashes?: boolean;
  /**
   * S6-F4: checks the connection's settings when it is created or changed; answers the first invalid key, or null.
   * The run checks them again (settings may predate the check).
   */
  settingsProblem?(settings: Record<string, unknown>): string | null;
  /** Opens the feed. Most connectors use `httpSource(ctx, { contentTypes })`. */
  fetch(ctx: ConnectorContext): Promise<FeedSource>;
  /** Streams records out of the source. Must not buffer the whole document. */
  parse(source: FeedSource, ctx: ConnectorContext): AsyncIterable<FeedRecord<Raw>>;
  /** One raw record → the connector's item (a listing draft for the loader, S6-02). */
  map(raw: Raw, ctx: ConnectorContext): MapResult<Item>;
  /** Business checks on a mapped item; [] when valid. */
  validate(item: Item, ctx: ConnectorContext): FeedItemProblem[];
}

const registry = new Map<string, FeedConnector>();

/** Registers a connector (at module load). A second registration of a key replaces the first (tests). */
export function registerConnector<Raw, Item>(connector: FeedConnector<Raw, Item>): () => void {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(connector.key)) throw new TypeError(`invalid connector key ${connector.key}`);
  const before = registry.get(connector.key);
  registry.set(connector.key, connector as FeedConnector);
  return () => {
    if (before) registry.set(connector.key, before);
    else registry.delete(connector.key);
  };
}

export function getConnector(key: string): FeedConnector | undefined {
  return registry.get(key);
}

export function connectorKeys(): string[] {
  return [...registry.keys()].sort();
}

/** Request headers for the stored credentials (Basic auth or one custom header; a `query` credential goes in the URL). */
export function credentialHeaders(credentials: FeedCredentials | null): Record<string, string> {
  if (!credentials) return {};
  if (credentials.type === 'basic') {
    return {
      authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
    };
  }
  if (credentials.type === 'query') return {};
  return { [credentials.name.toLowerCase()]: credentials.value };
}

/** The feed URL with a `query` credential added as a parameter (replacing one of the same name). */
export function credentialUrl(url: string, credentials: FeedCredentials | null): string {
  if (credentials?.type !== 'query') return url;
  const u = new URL(url);
  u.searchParams.set(credentials.name, credentials.value);
  return u.href;
}

/** Thrown when the feed answers with a non-2xx status (the run fails with `FEED_HTTP_STATUS`). */
export class FeedHttpStatusError extends Error {
  override readonly name = 'FeedHttpStatusError';
  constructor(readonly status: number) {
    super(`the feed answered HTTP ${status}`);
  }
}

/**
 * The default `fetch`: GET the connection's URL through `safeFetch` (SSRF checks on every hop, deadline, byte
 * cap, content types) with the credentials as headers.
 */
export async function httpSource(
  ctx: ConnectorContext,
  options: { contentTypes: readonly string[] } & Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes' | 'resolver'>,
): Promise<FeedSource> {
  const res = await safeFetch(credentialUrl(ctx.url, ctx.credentials), {
    headers: credentialHeaders(ctx.credentials),
    timeoutMs: options.timeoutMs ?? FEED_FETCH.TIMEOUT_MS,
    maxBytes: options.maxBytes ?? FEED_FETCH.MAX_BYTES,
    allowedContentTypes: options.contentTypes,
    signal: ctx.signal,
    ...(options.resolver ? { resolver: options.resolver } : {}),
  });
  if (!res.ok) {
    res.body.destroy();
    throw new FeedHttpStatusError(res.status);
  }
  return { body: res.body, bytesRead: res.bytesRead, contentType: res.contentType };
}

/** Content types XML feeds are served with. */
export const XML_CONTENT_TYPES = ['application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml'];

/** The default XML `parse`: one record per `recordElement`, numbered in feed order (XXE-safe, streaming). */
export async function* xmlRecords(
  source: FeedSource,
  options: XmlStreamOptions,
): AsyncGenerator<FeedRecord<XmlElement>> {
  let position = 0;
  for await (const raw of streamXmlRecords(source.body, options)) yield { position: position++, raw };
}

/** Thrown by a profile-driven connector whose mapping is missing or invalid (the run fails with `FEED_MAPPING_INVALID`). */
export class FeedMappingError extends Error {
  override readonly name = 'FeedMappingError';
  constructor() {
    super('the connection has no valid mapping profile');
  }
}

/** The shared `validate` of connectors that produce `FeedListing`s: the contract's own checks, first five issues. */
export function feedListingProblems(item: unknown): FeedItemProblem[] {
  const parsed = FeedListing.safeParse(item);
  if (parsed.success) return [];
  return parsed.error.issues.slice(0, 5).map((i) => ({
    code: 'INVALID_FIELD',
    field: i.path.map(String).join('.') || undefined,
    message: i.message.slice(0, 200),
  }));
}
