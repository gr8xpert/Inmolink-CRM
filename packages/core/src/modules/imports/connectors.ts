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
  /**
   * S7-F12: where a resumable connector continues this run — the `checkpoint` of the last `FeedMark` the run committed
   * (a retry, or the run's next slice). Absent: from the beginning. The connector checks its shape.
   */
  resume?: unknown;
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

/**
 * S7-F12: yielded by a resumable connector's `parse` between records, at a point the feed can be resumed from (Resales
 * Online: after each page). Once every record before it is committed, the run stores `checkpoint` in the same
 * transaction; a later attempt gets it back as `ConnectorContext.resume`. JSON only, small (it lives on the run row).
 */
export interface FeedMark {
  mark: true;
  checkpoint: unknown;
}

export const isFeedMark = (r: unknown): r is FeedMark =>
  typeof r === 'object' && r !== null && (r as { mark?: unknown }).mark === true;

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
   * S7-F12: `parse` yields `FeedMark`s and `fetch` honours `ConnectorContext.resume`: the run commits on the marks,
   * resumes after the last committed one, and hands its imports slot back every `RUNS.SLICE_MARKS` marks.
   */
  resumable?: boolean;
  /**
   * S7-F12: whether a stored checkpoint is one this connector can resume from (its shape and version); a run whose
   * checkpoint it refuses starts over.
   */
  acceptsCheckpoint?(checkpoint: unknown): boolean;
  /**
   * S6-F4: checks the connection's settings when it is created or changed; answers the first invalid key, or null.
   * The run checks them again (settings may predate the check).
   */
  settingsProblem?(settings: Record<string, unknown>): string | null;
  /** S7-F14: the one host this connector talks to; a connection saved with another URL is refused (FEED_URL_NOT_ALLOWED). */
  fixedHost?: string;
  /**
   * S7-F14: the connector sends running costs and the price range end whenever the listing has them, so an absent
   * value is a removed one and clears the stored one. Other connectors never send them and keep what is stored.
   */
  sendsCosts?: boolean;
  /** Opens the feed. Most connectors use `httpSource(ctx, { contentTypes })`. */
  fetch(ctx: ConnectorContext): Promise<FeedSource>;
  /** Streams records out of the source. Must not buffer the whole document. */
  parse(source: FeedSource, ctx: ConnectorContext): AsyncIterable<FeedRecord<Raw> | FeedMark>;
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

/**
 * S7-F12: the feed moved under a stored checkpoint (Resales: the last committed page no longer ends with the same
 * listing, or the announced count changed), so resuming could skip or repeat listings. The run starts over from the
 * beginning in the same job (its earlier slices' counters and seen references dropped, as on any restart).
 */
export class FeedCheckpointStaleError extends Error {
  override readonly name = 'FeedCheckpointStaleError';
  constructor() {
    super('the feed changed since the checkpoint; the run starts over');
  }
}

/** S7-F12: a resumable connector's feed broke its own contract (a page larger than any batch). `FEED_MALFORMED`. */
export class FeedMalformedError extends Error {
  override readonly name = 'FeedMalformedError';
  constructor(reason: string) {
    super(`the feed is malformed: ${reason}`);
  }
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
