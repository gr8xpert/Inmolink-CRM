import { createHash } from 'node:crypto';
import type { ApiKeyScope } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { AppError, isAppError } from '@inmolink/platform/errors';
import {
  ipBucket,
  LocalFixedWindows,
  type RateLimiter,
  replyQuotaExceeded,
  replyRateLimited,
} from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface RequireApiKeyOptions {
  /** A list endpoint: a request with a `cursor` counts against the paging rules (S7-04 anti-scraping). */
  paged?: boolean;
  /** `/v2/listings`: its cursor carries a signed page depth (deep-paging rules). */
  listings?: boolean;
  /** Filtered first pages of this search count towards filter-slicing (S7-F7). */
  slicing?: websiteApi.SliceEndpoint;
  /** A website form post (S7-05: leads, viewing requests): the form-spam limits apply too. */
  write?: boolean;
  /** A detail or sitemap request: the sync rules apply (S7-F7 detail / sync counting). */
  sync?: boolean;
  /**
   * The v1 shim only (S8-02): legacy websites send their key as this query parameter, and cannot be changed (the
   * cutover is a DNS flip). Only keys marked as migrated legacy keys (`legacyQueryKey`) are accepted that way; header
   * keys still win. Request logs never carry query strings (`stripQuery`); `api_key` is a redacted log key too.
   */
  keyParam?: string;
  /** The v1 shim only (S8-02): a request whose numbered page (this query parameter) is past the first is paged. */
  pageParam?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The website API caller, set by `requireApiKey`; null on routes without it. */
    apiKey: identity.ApiKeyPrincipal | null;
    /** What the paging rules said of the caller (S7-04), set by `requireApiKey`; null on routes without it. */
    websitePaging: { suspicious: boolean } | null;
    /** The `_k` edge-cache token this key and origin must send for a CDN-cacheable answer (S7-06, `edgeKeyToken`). */
    edgeKeyToken: string | null;
  }
  interface FastifyInstance {
    /**
     * `onRequest` hook for website API routes (S1-05, PATTERNS §11): authenticates the key sent as
     * `X-Api-Key` or `Authorization: Bearer`, checks the origin allowlist (publishable keys) and `scope`,
     * sets `request.apiKey` (so `scope: 'key'` rate rules see it), then checks the key's quotas and limits
     * (`websiteApi.checkWebsiteLimits`, S7-04): tier rate, the agency's ceiling, burst, daily quota (429
     * `QUOTA_EXCEEDED` with its reset time), per-browser limits for publishable keys and — on `paged` routes —
     * the paging rules. Failed key checks count against the client IP (429 past the limit).
     */
    requireApiKey(
      scope: ApiKeyScope,
      options?: RequireApiKeyOptions,
    ): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;
    /**
     * `/v2/changes` (S7-F7): credits a secret key with the UPSERTs of the page it is sent (once per entry), so the
     * detail requests its plugin makes to sync them do not count against its sync budget. Fire-and-forget: the response
     * never waits for it (the request keeps one awaited Redis call); failures are counted and logged by the limiter.
     */
    creditChangeFeed(
      request: FastifyRequest,
      changes: readonly { ref: string; change: string; changedAt: string }[],
    ): void;
  }
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** The longest legacy query-parameter key looked at (S8-02): longer values are no key at all. */
const MAX_QUERY_KEY = 200;

/**
 * The key from `X-Api-Key`, else from `Authorization: Bearer`. Never from the query string (logs, caches) — except the
 * legacy parameter of a v1 shim route (`keyParam`, S8-02), reported as `fromQuery`: only migrated legacy keys may come
 * that way.
 */
function keyOf(request: FastifyRequest, keyParam?: string): { key: string | undefined; fromQuery: boolean } {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header !== '') return { key: header.trim(), fromQuery: false };
  const auth = request.headers.authorization;
  const bearer = auth ? BEARER.exec(auth)?.[1] : undefined;
  if (bearer !== undefined || keyParam === undefined) return { key: bearer, fromQuery: false };
  const legacy = (request.query as Record<string, unknown> | undefined)?.[keyParam];
  return typeof legacy === 'string' && legacy !== '' && legacy.length <= MAX_QUERY_KEY
    ? { key: legacy.trim(), fromQuery: true }
    : { key: undefined, fromQuery: false };
}

/**
 * Rate-limit plugin rules for the keyed website routes (S7-F9): none — `requireApiKey` (in `onRequest`) governs them,
 * with the key's tier, the agency's ceiling, burst, daily quota, the per-browser rules of publishable keys and the paging,
 * slicing and sync budgets (S7-04, S7-F7), in one Redis call. The plugin's per-IP default (`feed.ip`, 1,200 / min) is
 * wrong for them: a site's server calls from one IP (shared hosting serves many sites from one), and a HIGH-tier key
 * alone may send 3,000 / min. Calls without a usable key — missing, malformed, unknown — count against
 * `API_KEY_FAILURE_RULE` per client IP (429 past 60 / min) before any other work; browsers stay limited per browser.
 */
export const KEYED_ROUTE_LIMITS = false as const;

/** The client IP's failed key checks are in the penalty box (S7-F9): 429 without a database lookup. */
class FailedChecksPenalty extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('failed key checks: penalty');
  }
}

/** Key errors that count as a failed check against the client IP (S7-F9 security review: probing origins and scopes too). */
const FAILED_CHECK_CODES: ReadonlySet<string> = new Set([
  'API_KEY_INVALID',
  'API_KEY_ORIGIN_DENIED',
  'API_KEY_SCOPE_DENIED',
]);

/**
 * Failed key checks per client IP in this process (S7-F9 security review): the fallback when Redis cannot answer —
 * the shared limiter fails open, so without it a Redis outage would leave guessed-key lookups unbounded. Same limit
 * and window as `API_KEY_FAILURE_RULE`, fixed windows (S8-F6 `LocalFixedWindows`), at most `FAILED_CHECKS_TRACKED`
 * addresses. An address with no window is never refused (a flood of new addresses cannot lock out others); a full map
 * evicts its oldest address under the limit and never one in the penalty box.
 */
export const FAILED_CHECKS_TRACKED = 10_000;

export type LocalFailedChecks = LocalFixedWindows<'ip'>;

export function createLocalFailedChecks(max = FAILED_CHECKS_TRACKED): LocalFailedChecks {
  return new LocalFixedWindows<'ip'>({ ip: { max, windowMs: identity.API_KEY_FAILURE_RULE.windowSeconds * 1_000 } });
}

export function apiKeyPlugin(app: FastifyZod, deps: { limiter: RateLimiter; localFailures?: LocalFailedChecks }): void {
  const local = deps.localFailures ?? createLocalFailedChecks();
  app.decorateRequest('apiKey', null);
  app.decorateRequest('websitePaging', null);
  app.decorateRequest('edgeKeyToken', null);
  app.decorate(
    'requireApiKey',
    (scope: ApiKeyScope, options: RequireApiKeyOptions = {}) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        let principal: identity.ApiKeyPrincipal;
        const ip = ipBucket(request.ip);
        const { key, fromQuery } = keyOf(request, options.keyParam);
        try {
          principal = await identity.authenticateApiKey({
            key,
            origin: request.headers.origin,
            scope,
            // S7-F9: an IP in the failed-checks penalty box gets no database lookup for a key no cache knows. Only on a
            // cache miss: keys served from the key cache keep working for everyone else on a shared address. The
            // in-process count stands in when Redis cannot answer (the limiter then allows).
            beforeLookup: async () => {
              const localWait = local.peek('ip', ip, identity.API_KEY_FAILURE_RULE.limit);
              if (localWait > 0) throw new FailedChecksPenalty(localWait);
              const [peeked] = await deps.limiter.consumeMany([
                { rule: identity.API_KEY_FAILURE_RULE, identity: ip, peek: true },
              ]);
              if (peeked && !peeked.allowed) throw new FailedChecksPenalty(peeked.retryAfterSeconds);
            },
          });
          // S8-02: a key in the query string must be a migrated legacy key; a v2 key sent that way is refused (and counts
          // as a failed check), so v2 keys never start living in URLs.
          if (fromQuery && !principal.legacyQueryKey) throw new AppError('API_KEY_INVALID');
        } catch (err) {
          if (err instanceof FailedChecksPenalty) return replyRateLimited(reply, 'ip', err.retryAfterSeconds);
          // Unknown keys are never cached, so guessing costs a query: cap failed checks per client IP — a wrong key, and
          // (S7-F9) a real key tried from other origins or for other scopes.
          if (isAppError(err) && FAILED_CHECK_CODES.has(err.code)) {
            // False when the address went untracked (the map is full of addresses in the penalty box): ignored — the
            // shared rule below still counts it, and an untracked address is never boxed locally.
            local.hit('ip', ip, identity.API_KEY_FAILURE_RULE.limit);
            const failed = await deps.limiter.consume(identity.API_KEY_FAILURE_RULE, ip);
            if (!failed.allowed) return replyRateLimited(reply, 'ip', failed.retryAfterSeconds);
          }
          throw err;
        }
        request.apiKey = principal;
        request.edgeKeyToken = edgeKeyToken(key as string, request.headers.origin);
        // The key's tier, the agency's ceiling, burst, daily quota, per-browser limits (publishable keys) and the paging
        // rules (S7-04): one Redis round trip, decided in core.
        const cursor = cursorOf(request);
        const decision = await websiteApi.checkWebsiteLimits(deps.limiter, principal, {
          ip: ipBucket(request.ip),
          paged: options.paged === true && (cursor !== undefined || pastFirstPage(request, options.pageParam)),
          listingsCursor: options.listings === true ? cursor : undefined,
          // S7-F7: a filtered first page of `/v2/listings` or `/v2/developments` counts towards filter-slicing (its
          // signature from the query as the route's schema parses it); details and sitemap pages towards the sync budget.
          filterSignature:
            options.slicing !== undefined && cursor === undefined && !pastFirstPage(request, options.pageParam)
              ? websiteApi.sliceSignature(options.slicing, request.query)
              : undefined,
          sync: options.sync === true,
          write: options.write === true,
          requestId: request.id,
        });
        if (!decision.allowed) {
          request.log.info({ scope: decision.scope, kind: decision.kind, keyId: principal.keyId }, 'rate limited');
          return decision.kind === 'quota'
            ? replyQuotaExceeded(reply, { ...decision, period: 'daily' })
            : replyRateLimited(reply, decision.scope, decision.retryAfterSeconds);
        }
        request.websitePaging = { suspicious: decision.suspicious };
        return undefined;
      },
  );
  app.decorate(
    'creditChangeFeed',
    (request: FastifyRequest, changes: readonly { ref: string; change: string; changedAt: string }[]) => {
      if (request.apiKey?.kind !== 'SECRET') return;
      websiteApi.creditChangeFeed(deps.limiter, request.apiKey, changes).catch((err) => {
        request.log.warn({ err }, 'change-feed credit failed');
      });
    },
  );
}

/**
 * The edge-cache token (S7-06, contracts `EdgeKeyToken`): base64url(SHA-256(`<key>
<Origin or empty>`)), 22
 * characters. Only a request carrying it as `_k` gets a CDN-cacheable answer, so cached URLs differ per key and browser
 * origin even if the CDN's header rule were missing. Not a secret proof (it is derived from the key the request sends).
 */
export function edgeKeyToken(key: string, origin?: string): string {
  return createHash('sha256')
    .update(`${key}
${origin ?? ''}`)
    .digest('base64url')
    .slice(0, 22);
}

/** The `cursor` in the query string: the request continues a list (S7-04 paging rules). */
function cursorOf(request: FastifyRequest): string | undefined {
  const cursor = (request.query as Record<string, unknown> | undefined)?.cursor;
  return typeof cursor === 'string' && cursor !== '' ? cursor : undefined;
}

/** A v1 shim request for a numbered page after the first (S8-02: legacy `page`). */
function pastFirstPage(request: FastifyRequest, pageParam: string | undefined): boolean {
  if (pageParam === undefined) return false;
  const page = (request.query as Record<string, unknown> | undefined)?.[pageParam];
  return typeof page === 'number' ? page > 1 : typeof page === 'string' && Number(page) > 1;
}
