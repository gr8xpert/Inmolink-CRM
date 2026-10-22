import { createHash } from 'node:crypto';
import { type FeedListingInput, RESALES_API_HOST, ResalesFeedSettings } from '@inmolink/contracts';
import { isSafeFetchError, safeFetch } from '@inmolink/platform/safe-fetch';
import { z } from 'zod';
import { FEED_FETCH } from '../config';
import {
  type ConnectorContext,
  FeedCheckpointStaleError,
  type FeedConnector,
  type FeedMark,
  type FeedRecord,
  type FeedSource,
  feedListingProblems,
  registerConnector,
} from '../connectors';
import {
  isOwnProperty,
  mapResalesProperty,
  OWN_PROPERTY_KEYS,
  RESALES_LANGUAGE_CODES,
  type ResalesItem,
  type ResalesRecord,
  type ResalesSettings,
  resalesSettings,
} from './mapping';

/**
 * The Resales Online connector (S6-06, reworked in S6-F4 to the request and response shapes of the SPW project's
 * adapter, which runs in production): WebAPI V6 `SearchProperties`, the agency's own listings only.
 *
 * Per page: one `SearchProperties` call (`p_agency_filterid` = the connection's Filter Alias, `P_PageNo`,
 * `P_PageSize`). Records that are not the agency's own (`OwnProperty` not "1") are dropped here and only counted (a
 * page with no own-property field at all fails the run: the field name is unconfirmed until H13). An own record whose
 * list fields hash as last stored (`ConnectorContext.sourceHashes`, trusted 7 days) is reported as seen only: no
 * further call, not rewritten, not withdrawn. For the others, `PropertyDetails` (coordinates, year, energy rating,
 * nested location) and one `SearchProperties` call per extra language (numeric `P_Lang`) run together, at most 5 calls
 * in flight per Resales account. A record whose details or a language could not be read is an item error with its
 * reference: kept as it is, never written with less, never withdrawn.
 *
 * Every call goes through the account's gate (per agency and credentials, shared by the process's runs): at most 5 in flight, and
 * a busy answer ("P1 or P2 not valid", which Resales also gives for wrong keys), a 5xx, a 429 (its `Retry-After`) or a
 * network failure pauses the account's calls (2 s, then 4 s) before the call is tried again, 3 attempts in all.
 *
 * Paging stops when the records reach `QueryInfo.PropertyCount`, or on an empty or short page (shorter than
 * `PropertiesPerPage`, or than the first page when the API does not say). The API caps a page at 40 whatever is asked.
 * The run has a deadline sized to `PropertyCount`; only search pages count against the feed byte cap.
 *
 * S7-F12: resumable. After each page `parse` yields a mark (`ResalesCheckpoint`: the page, the records fetched so far,
 * the paging state and the next record position); a retry or the run's next slice starts at the page after the last
 * committed one, with the deadline sized to the account again, so an account of any size completes across slices.
 *
 * Credentials are a `basic` credential: user name = the Client ID (`p1`), password = the API key (`p2`). They travel
 * as query parameters (what the API takes), only over https, only to `webapi.resales-online.com:443`, with no
 * redirects followed; they are removed (raw, URL-encoded, any case, any `p1=` / `p2=` pair) from any API message
 * before it is kept.
 */

export const RESALES_HOST: string = RESALES_API_HOST;
export const RESALES_PAGE_SIZE = 40;
export const RESALES_MAX_PAGES = 1_000;
/** Calls in flight per Resales account (SPW: 5 is safe). */
export const RESALES_CONCURRENCY = 5;
/** Attempts per call; between them the account's calls pause `attempt × RESALES_BACKOFF_MS` (SPW: 2 s, 4 s). */
export const RESALES_ATTEMPTS = 3;
export const RESALES_BACKOFF_MS = 2_000;
/** A `Retry-After` longer than this is cut to it. */
export const RESALES_RETRY_AFTER_MAX_MS = 60_000;
export const RESALES_SEARCH_TIMEOUT_MS = 60_000;
export const RESALES_DETAILS_TIMEOUT_MS = 15_000;
/** The run's deadline: a base plus a share per listing of `PropertyCount` (set once page 1 answered). */
export const RESALES_DEADLINE = { BASE_MS: 15 * 60_000, PER_LISTING_MS: 1_000 } as const;
/** A change here re-fetches every listing once (the hash covers the mapping's inputs). */
const HASH_VERSION = 's7-f14.1';
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const BUSY_TEXT = /P1 or P2 not valid/i;

/** The connection cannot be used (no basic credentials, a host that is not the Resales API, a bad filter alias). */
export class ResalesConfigError extends Error {
  override readonly name = 'ResalesConfigError';
  constructor(readonly reason: 'CREDENTIALS_REQUIRED' | 'HOST_NOT_ALLOWED' | 'FILTER_ALIAS_INVALID') {
    super(`the Resales Online connection is not usable: ${reason}`);
  }
}

/**
 * The API did not give a usable answer. `REFUSED`: `transaction.status` "error" (`descriptions` are Resales'
 * `errordescription` texts, credentials removed); `CREDENTIALS`: still "P1 or P2 not valid" after the retries;
 * `HTTP`: a non-2xx status (with Resales' descriptions when the body had them); `MALFORMED`: not a Resales answer, a
 * page that repeats, a page without the own-property field, the byte cap or the page cap; `DEADLINE`: the run's
 * deadline passed.
 */
export class ResalesApiError extends Error {
  override readonly name = 'ResalesApiError';
  constructor(
    readonly kind: 'REFUSED' | 'CREDENTIALS' | 'HTTP' | 'MALFORMED' | 'DEADLINE',
    readonly descriptions: readonly string[] = [],
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(
      `the Resales Online API did not return a usable answer (${kind}${status ? ` ${status}` : ''})${
        descriptions.length ? `: ${descriptions.join('; ')}` : ''
      }`,
    );
  }
}

export interface ResalesRequest {
  url: string;
  signal: AbortSignal;
  timeoutMs: number;
}
export interface ResalesResponse {
  status: number;
  text: string;
  /** The `Retry-After` header, when sent. */
  retryAfter?: string | null;
}
/** Sends one GET and returns its status and body (also for a non-2xx answer: Resales' error body is kept). Replaced in tests. */
export type ResalesFetcher = (request: ResalesRequest) => Promise<ResalesResponse>;

const safeGet: ResalesFetcher = async ({ url, signal, timeoutMs }) => {
  const res = await safeFetch(url, {
    timeoutMs,
    maxBytes: MAX_PAGE_BYTES,
    maxRedirects: 0,
    // Error pages come as HTML or XML too: read them (as not-JSON), never fail on their type.
    allowedContentTypes: ['application/json', 'text/json', 'text/plain', 'text/html', 'application/xml', 'text/xml'],
    signal,
  });
  const retryAfter = res.headers['retry-after'];
  return { status: res.status, text: await res.text(), retryAfter: typeof retryAfter === 'string' ? retryAfter : null };
};

type Endpoint = 'SearchProperties' | 'PropertyDetails';

function credentialsOf(ctx: Pick<ConnectorContext, 'credentials'>) {
  if (ctx.credentials?.type !== 'basic') throw new ResalesConfigError('CREDENTIALS_REQUIRED');
  return { p1: ctx.credentials.username, p2: ctx.credentials.password };
}

function settingsOf(ctx: Pick<ConnectorContext, 'settings'>): ResalesSettings {
  try {
    return resalesSettings(ctx.settings);
  } catch {
    throw new ResalesConfigError('FILTER_ALIAS_INVALID');
  }
}

/** A request URL. Throws `ResalesConfigError` before anything is sent. The stored URL's query is never sent. */
export function resalesUrl(
  ctx: Pick<ConnectorContext, 'url' | 'credentials' | 'settings'>,
  endpoint: Endpoint,
  params: Record<string, string | number>,
): string {
  const { p1, p2 } = credentialsOf(ctx);
  const { filterAlias } = settingsOf(ctx);
  const u = new URL(ctx.url);
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== RESALES_HOST || (u.port !== '' && u.port !== '443'))
    throw new ResalesConfigError('HOST_NOT_ALLOWED');
  // The stored URL names the API base (".../V6") or one of its endpoints; the endpoint is ours.
  u.pathname = /\/(SearchProperties|PropertyDetails)\/?$/i.test(u.pathname)
    ? u.pathname.replace(/\/[^/]*\/?$/, `/${endpoint}`)
    : `${u.pathname.replace(/\/$/, '')}/${endpoint}`;
  u.search = '';
  u.hash = '';
  u.searchParams.set('p_agency_filterid', filterAlias);
  u.searchParams.set('p1', p1);
  u.searchParams.set('p2', p2);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.href;
}

/** One `SearchProperties` page (English unless `lang` names a Resales language number). */
export function resalesPageUrl(
  ctx: Pick<ConnectorContext, 'url' | 'credentials' | 'settings'>,
  page: number,
  lang?: number,
): string {
  return resalesUrl(ctx, 'SearchProperties', {
    P_PageNo: page,
    P_PageSize: RESALES_PAGE_SIZE,
    ...(lang ? { P_Lang: lang } : {}),
  });
}

/** One property's `PropertyDetails` (the SPW parameters: GPS, decimal baths, price list, development name). */
export function resalesDetailsUrl(ctx: Pick<ConnectorContext, 'url' | 'credentials' | 'settings'>, ref: string) {
  return resalesUrl(ctx, 'PropertyDetails', {
    P_RefId: ref,
    P_Lang: 'EN',
    P_Dimension: 1,
    p_pricelist: 'TRUE',
    P_shownewdevname: 'TRUE',
    P_DecimalBaths: 1,
    P_ShowGPSCoords: 'TRUE',
  });
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const records = (v: unknown): ResalesRecord[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map((r) => asObject(r) ?? {});
const refOf = (r: ResalesRecord) =>
  typeof r.Reference === 'string' || typeof r.Reference === 'number' ? String(r.Reference).trim() : '';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Removes the credentials from a text that reaches logs and (S7-F12) the run's `error_detail`: every `p1=…` / `p2=…`
 * pair (`=` raw, encoded or double-encoded), and each secret raw, URL-encoded (`encodeURIComponent`, twice, and the `+`
 * form of URLSearchParams) or base64 (padded, unpadded, URL-safe; also the `p1:p2` pair as Basic auth sends it), in
 * any case. Longest forms first, so a shorter one never leaves part of a longer one behind.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let t = text.replace(/\b(p1|p2)(=|%3D|%253D)[^&\s"'<>;,()]*/gi, '$1=[redacted]');
  const given = secrets.filter(Boolean);
  const forms = new Set<string>();
  for (const s of given)
    for (const f of [
      s,
      encodeURIComponent(s),
      encodeURIComponent(encodeURIComponent(s)),
      new URLSearchParams({ x: s }).toString().slice(2),
      ...base64Forms(s),
    ])
      forms.add(f);
  if (given.length === 2) for (const f of base64Forms(given.join(':'))) forms.add(f);
  for (const f of [...forms].sort((a, b) => b.length - a.length))
    if (f) t = t.replace(new RegExp(escapeRe(f), 'gi'), '[redacted]');
  return t;
}

/** A secret as base64: padded, unpadded and URL-safe. */
function base64Forms(s: string): string[] {
  const b = Buffer.from(s, 'utf8').toString('base64');
  return [b, b.replace(/=+$/, ''), Buffer.from(s, 'utf8').toString('base64url')];
}

/** Resales' error texts, without the credentials and bounded (they reach logs). */
function descriptionsOf(root: Record<string, unknown> | null, secrets: readonly string[]): string[] {
  const desc = asObject(asObject(root?.transaction)?.errordescription) ?? {};
  return Object.values(desc)
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map((v) =>
      Array.from(redactSecrets(String(v), secrets))
        .slice(0, 300)
        .join(''),
    ) // code points: never half a character
    .filter(Boolean)
    .slice(0, 5);
}

/** `Retry-After` in seconds or as an HTTP date, bounded; null when absent or unreadable. */
function retryAfterMs(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  const ms = /^\d+$/.test(v) ? Number(v) * 1_000 : Date.parse(v) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RESALES_RETRY_AFTER_MAX_MS) : null;
}

/** Reads one answer: `data.root || data`; fails only on `transaction.status === 'error'` or a non-2xx status. */
export function readResalesAnswer(res: ResalesResponse, secrets: readonly string[] = []): Record<string, unknown> {
  let data: Record<string, unknown> | null = null;
  try {
    data = asObject(JSON.parse(res.text));
  } catch {
    data = null;
  }
  const root = asObject(data?.root) ?? data;
  const refused = asObject(root?.transaction)?.status === 'error';
  const descriptions = descriptionsOf(root, secrets);
  if (res.status < 200 || res.status > 299) {
    const wait = res.status === 429 || res.status === 503 ? retryAfterMs(res.retryAfter, Date.now()) : null;
    throw new ResalesApiError('HTTP', descriptions, res.status, wait ?? undefined);
  }
  if (refused) throw new ResalesApiError('REFUSED', descriptions);
  if (!root) throw new ResalesApiError('MALFORMED');
  return root;
}

/** The busy answer: "P1 or P2 not valid", whatever the HTTP status. */
const isBusy = (err: unknown) =>
  err instanceof ResalesApiError &&
  (err.kind === 'REFUSED' || err.kind === 'HTTP') &&
  err.descriptions.some((d) => BUSY_TEXT.test(d));

/** Worth another attempt: busy, a 5xx / 429 / 408, or the network (a timeout of this call alone included). */
const isTransient = (err: unknown) =>
  isBusy(err) ||
  (err instanceof ResalesApiError &&
    err.kind === 'HTTP' &&
    ((err.status ?? 0) >= 500 || err.status === 429 || err.status === 408)) ||
  (isSafeFetchError(err) && (err.code === 'TIMEOUT' || err.code === 'NETWORK' || err.code === 'DNS_FAILED'));

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;
const sleepFor: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * One Resales account's calls in this process (keyed by a hash of agency id, Client ID and API key: two connections of
 * one agency with the same credentials, e.g. two filter aliases, share it, which is when Resales answers "busy"; another
 * agency typing the same Client ID with any key never does, so its refusals cannot pause a real account's imports):
 * at most `limit` in flight, and a pause every call waits
 * out before it starts.
 */
export class ResalesGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private pausedUntil = 0;
  constructor(
    readonly limit: number,
    private readonly now: () => number,
    private readonly sleep: Sleep,
  ) {}

  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  async run<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal.removeEventListener('abort', stop);
          resolve();
        };
        const stop = () => {
          const i = this.waiting.indexOf(go);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(signal.reason);
        };
        if (signal.aborted) return reject(signal.reason);
        this.waiting.push(go);
        signal.addEventListener('abort', stop, { once: true });
      });
    }
    this.active++;
    try {
      for (let wait = this.pausedUntil - this.now(); wait > 0; wait = this.pausedUntil - this.now())
        await this.sleep(wait, signal);
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export interface ResalesConnectorOptions {
  key?: string;
  /** Waits (tests pass a fake that advances `now`). */
  sleep?: Sleep;
  now?: () => number;
  /** The run deadline (tests shorten it). */
  deadline?: { BASE_MS: number; PER_LISTING_MS: number };
}

/**
 * S7-F12: where a run continues: after `page`, with the paging state the next page needs. `position` is the next
 * record's position (the run's item errors stay in feed order across slices). Version `v` changes with the shape.
 */
export const ResalesCheckpoint = z
  .object({
    v: z.literal(1),
    page: z.number().int().min(1).max(RESALES_MAX_PAGES),
    position: z.number().int().min(0),
    fetched: z.number().int().min(0),
    firstRef: z.string().max(200).nullable(),
    /** The last record of `page` (any agency's): a resume reads `page` again and starts over if it changed. */
    lastRef: z.string().max(200).nullable(),
    pageSize: z.number().int().min(1).nullable(),
    total: z.number().int().min(0).nullable(),
  })
  .strict();
export type ResalesCheckpoint = z.infer<typeof ResalesCheckpoint>;

/** One page as the connector yields it: the records to map, in feed order (own ones only), and its mark. */
interface ResalesChunk {
  searchType: string | null;
  items: ResalesItem[];
  /** The checkpoint after this page (`parse` adds the position). */
  next: Omit<ResalesCheckpoint, 'position'>;
}

/** The hash of an own list record as fetched (and of what else decides the mapped listing). */
function sourceHash(record: ResalesRecord, searchType: string | null, settings: ResalesSettings): string {
  return createHash('sha256')
    .update(JSON.stringify([HASH_VERSION, settings.filterAlias, settings.languages, searchType, record]))
    .digest('hex');
}

export function createResalesConnector(
  fetcher: ResalesFetcher,
  options: ResalesConnectorOptions = {},
): FeedConnector<ResalesItem, FeedListingInput> {
  const sleep = options.sleep ?? sleepFor;
  const now = options.now ?? Date.now;
  const deadlineOf = options.deadline ?? RESALES_DEADLINE;
  const gates = new Map<string, ResalesGate>();
  const gateFor = (account: string) => {
    let g = gates.get(account);
    if (!g) {
      g = new ResalesGate(RESALES_CONCURRENCY, now, sleep);
      gates.set(account, g);
    }
    return g;
  };

  return {
    key: options.key ?? 'resales-online',
    sourceHashes: true,
    resumable: true,
    fixedHost: RESALES_HOST,
    sendsCosts: true,
    acceptsCheckpoint: (checkpoint) => ResalesCheckpoint.safeParse(checkpoint).success,
    settingsProblem(settings) {
      const parsed = ResalesFeedSettings.safeParse(settings);
      return parsed.success ? null : String(parsed.error.issues[0]?.path[0] ?? 'settings');
    },
    async fetch(ctx): Promise<FeedSource> {
      resalesPageUrl(ctx, 1); // fail before the run starts
      const { p1, p2 } = credentialsOf(ctx);
      const secrets = [p1, p2];
      const settings = settingsOf(ctx);
      // S7-F12: the runner offers only checkpoints `acceptsCheckpoint` took; anything else is a bug, not a restart.
      let resume: ResalesCheckpoint | null = null;
      if (ctx.resume !== undefined && ctx.resume !== null) {
        const parsed = ResalesCheckpoint.safeParse(ctx.resume);
        if (!parsed.success) throw new ResalesApiError('MALFORMED');
        resume = parsed.data;
      }
      const gate = gateFor(
        createHash('sha256')
          .update(JSON.stringify([ctx.agencyId, p1, p2]))
          .digest('hex'),
      );
      const deadline = new AbortController();
      const signal = AbortSignal.any([ctx.signal, deadline.signal]);
      let deadlineTimer: NodeJS.Timeout | undefined;
      const setDeadline = (ms: number) => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        deadlineTimer = setTimeout(() => deadline.abort(new ResalesApiError('DEADLINE')), ms);
        deadlineTimer.unref?.();
      };
      setDeadline(deadlineOf.BASE_MS);
      let searchBytes = 0;
      let bytes = 0;
      const stats = {
        pages: 0,
        notOwn: 0,
        unchanged: 0,
        detailed: 0,
        detailsFailed: 0,
        languageCalls: 0,
        languagesFailed: 0,
        translationsMissing: 0,
        retries: 0,
      };

      /** The abort that ended a call, as the run should see it. */
      const stopped = (err: unknown) => {
        if (deadline.signal.aborted) return new ResalesApiError('DEADLINE');
        if (ctx.signal.aborted) return ctx.signal.reason ?? err;
        return null;
      };
      /** One call through the account's gate, with the transient retries. */
      const call = async (url: string, kind: 'search' | 'details' | 'language') => {
        for (let attempt = 1; ; attempt++) {
          try {
            const res = await gate.run(
              () =>
                fetcher({
                  url,
                  signal,
                  timeoutMs: kind === 'details' ? RESALES_DETAILS_TIMEOUT_MS : RESALES_SEARCH_TIMEOUT_MS,
                }),
              signal,
            );
            const size = Buffer.byteLength(res.text);
            bytes += size;
            if (kind === 'search') {
              searchBytes += size;
              if (searchBytes > FEED_FETCH.MAX_BYTES) throw new ResalesApiError('MALFORMED');
            }
            return readResalesAnswer(res, secrets);
          } catch (err) {
            const abort = stopped(err);
            if (abort) throw abort;
            if (!isTransient(err) || attempt >= RESALES_ATTEMPTS) {
              if (isBusy(err)) throw new ResalesApiError('CREDENTIALS', (err as ResalesApiError).descriptions);
              throw err;
            }
            stats.retries++;
            const wait = err instanceof ResalesApiError ? err.retryAfterMs : undefined;
            gate.pause(wait ?? attempt * RESALES_BACKOFF_MS); // every call of the account waits it out
          }
        }
      };
      /** A details call that still fails after the retries costs only this listing (kept as it is). */
      const details = async (ref: string): Promise<ResalesRecord | null> => {
        try {
          const root = await call(resalesDetailsUrl(ctx, ref), 'details');
          const detail = records(root.Property)[0];
          return detail && refOf(detail) === ref ? detail : null;
        } catch (err) {
          const abort = stopped(err);
          if (abort) throw abort;
          return null;
        }
      };
      /** One language's page: ref → description, or null when it could not be read after the retries. */
      const language = async (page: number, code: number): Promise<Map<string, string> | null> => {
        stats.languageCalls++;
        try {
          const root = await call(resalesPageUrl(ctx, page, code), 'language');
          const out = new Map<string, string>();
          for (const r of records(root.Property)) {
            const text = typeof r.Description === 'string' ? r.Description.trim() : '';
            out.set(refOf(r), text);
          }
          return out;
        } catch (err) {
          const abort = stopped(err);
          if (abort) throw abort;
          return null;
        }
      };

      async function* pages(): AsyncGenerator<Uint8Array> {
        let fetched = resume?.fetched ?? 0;
        let firstRef: string | undefined = resume?.firstRef ?? undefined;
        let pageSize: number | undefined = resume?.pageSize ?? undefined;
        let announced: number | null = resume?.total ?? null;
        try {
          if (resume) {
            // Every listing the API announced was read before the run stopped: nothing is left to fetch.
            if (announced !== null && fetched >= announced) return;
            if (announced !== null && announced > 0)
              setDeadline(deadlineOf.BASE_MS + announced * deadlineOf.PER_LISTING_MS);
            // The feed may have moved since the checkpoint (a listing added or removed before it shifts every later
            // page): the last committed page must still end with the same listing and the count must be the same, or
            // resuming would skip or repeat listings — the run starts over instead (its records are not yielded again).
            const again = await call(resalesPageUrl(ctx, resume.page), 'search');
            stats.pages++;
            const list = records(again.Property);
            const count = Number.parseInt(String(asObject(again.QueryInfo)?.PropertyCount ?? ''), 10);
            const lastRef = list.length > 0 ? refOf(list[list.length - 1] as ResalesRecord) : null;
            if (lastRef !== resume.lastRef || (Number.isFinite(count) ? count : null) !== resume.total)
              throw new FeedCheckpointStaleError();
          }
          for (let page = (resume?.page ?? 0) + 1; page <= RESALES_MAX_PAGES; page++) {
            const root = await call(resalesPageUrl(ctx, page), 'search');
            stats.pages++;
            const list = records(root.Property);
            const info = asObject(root.QueryInfo);
            const total = Number.parseInt(String(info?.PropertyCount ?? ''), 10);
            const perPage = Number.parseInt(String(info?.PropertiesPerPage ?? ''), 10);
            const searchType = typeof info?.SearchType === 'string' ? info.SearchType : null;
            const first = list[0] ? refOf(list[0]) : undefined;
            // An API that ignores the page number would repeat page 1: stop instead of paging for ever.
            if (page > 1 && first && first === firstRef) throw new ResalesApiError('MALFORMED');
            if (page === 1) {
              firstRef = first;
              pageSize = Number.isFinite(perPage) && perPage > 0 ? perPage : list.length;
              if (Number.isFinite(total) && total > 0)
                setDeadline(deadlineOf.BASE_MS + total * deadlineOf.PER_LISTING_MS);
            }
            if (Number.isFinite(total) && total >= 0) announced = total;
            // Fail closed until H13 confirms the field: a page without any own-property field imports nothing.
            if (list.length > 0 && !list.some((r) => OWN_PROPERTY_KEYS.some((k) => k in r)))
              throw new ResalesApiError('MALFORMED');

            const own = list.filter((r) => isOwnProperty(r) && refOf(r));
            stats.notOwn += list.length - own.length;
            const known = own.length > 0 && ctx.sourceHashes ? await ctx.sourceHashes(own.map(refOf)) : new Map();
            const items: ResalesItem[] = own.map((r) => {
              const ref = refOf(r);
              const hash = sourceHash(r, searchType, settings);
              if (known.get(ref) === hash) {
                stats.unchanged++;
                return { own: true, ref, unchanged: true };
              }
              return { own: true, ref, property: r, sourceHash: hash };
            });
            const changed = items.filter((i) => !i.unchanged);
            if (changed.length > 0) {
              // Details and the languages together, bounded by the account's gate.
              const [got, langs] = await Promise.all([
                Promise.all(changed.map((i) => details(i.ref as string))),
                Promise.all(
                  settings.languages.map(async (locale) => {
                    const code = RESALES_LANGUAGE_CODES[locale];
                    return [locale, code === undefined ? new Map() : await language(page, code)] as const;
                  }),
                ),
              ]);
              changed.forEach((item, j) => {
                const detail = got[j] ?? null;
                if (!detail) {
                  stats.detailsFailed++;
                  item.failure = 'DETAILS_UNAVAILABLE';
                  return;
                }
                stats.detailed++;
                item.detail = detail;
              });
              for (const [locale, texts] of langs) {
                if (texts === null) stats.languagesFailed++;
                for (const item of changed) {
                  if (item.failure) continue;
                  const text = texts?.get(item.ref as string);
                  // A failed language, or a listing that moved between the calls: never a reduced translation set.
                  if (text === undefined) {
                    stats.translationsMissing++;
                    item.failure = 'TRANSLATIONS_UNAVAILABLE';
                  } else if (text) item.descriptions = { ...item.descriptions, [locale]: text };
                }
              }
            }

            fetched += list.length;
            const chunk: ResalesChunk = {
              searchType,
              items,
              next: {
                v: 1,
                page,
                fetched,
                firstRef: firstRef ?? null,
                lastRef: list.length > 0 ? refOf(list[list.length - 1] as ResalesRecord) : null,
                pageSize: pageSize ?? null,
                total: announced,
              },
            };
            yield Buffer.from(JSON.stringify(chunk)); // one page per chunk
            if (list.length === 0 || (Number.isFinite(total) && fetched >= total)) return;
            if (pageSize !== undefined && list.length < pageSize) return; // a short page is the last
          }
          throw new ResalesApiError('MALFORMED'); // cut off at the page cap: failing keeps the missing tail from being withdrawn
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }
      }
      return {
        body: pages(),
        bytesRead: () => bytes,
        contentType: 'application/json',
        stats: () => ({ ...stats }),
      };
    },
    async *parse(source, ctx): AsyncGenerator<FeedRecord<ResalesItem> | FeedMark> {
      const resumed = ResalesCheckpoint.safeParse(ctx.resume);
      let position = resumed.success ? resumed.data.position : 0;
      for await (const raw of source.body) {
        let chunk: ResalesChunk;
        try {
          chunk = JSON.parse(Buffer.from(raw).toString('utf8')) as ResalesChunk;
        } catch {
          throw new ResalesApiError('MALFORMED');
        }
        if (!Array.isArray(chunk?.items)) throw new ResalesApiError('MALFORMED');
        for (const item of chunk.items) yield { position: position++, raw: { ...item, searchType: chunk.searchType } };
        if (chunk.next) yield { mark: true, checkpoint: { ...chunk.next, position } };
      }
    },
    map: (raw, ctx) => mapResalesProperty(raw, settingsOf(ctx)),
    validate: (item) => feedListingProblems(item),
  };
}

export const resalesConnector = createResalesConnector(safeGet);

registerConnector(resalesConnector);
