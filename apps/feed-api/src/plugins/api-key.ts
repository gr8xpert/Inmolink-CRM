import type { ApiKeyScope } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { isAppError } from '@inmolink/platform/errors';
import { ipBucket, type RateLimiter, replyQuotaExceeded, replyRateLimited } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface RequireApiKeyOptions {
  /** A list endpoint: a request with a `cursor` counts against the paging rules (S7-04 anti-scraping). */
  paged?: boolean;
  /** `/v2/listings`: its cursor carries a signed page depth (deep-paging rules). */
  listings?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The website API caller, set by `requireApiKey`; null on routes without it. */
    apiKey: identity.ApiKeyPrincipal | null;
    /** What the paging rules said of the caller (S7-04), set by `requireApiKey`; null on routes without it. */
    websitePaging: { suspicious: boolean } | null;
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
  }
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** The key from `X-Api-Key`, else from `Authorization: Bearer`. Never from the query string (logs, caches). */
function keyOf(request: FastifyRequest): string | undefined {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header !== '') return header.trim();
  const auth = request.headers.authorization;
  return auth ? BEARER.exec(auth)?.[1] : undefined;
}

export function apiKeyPlugin(app: FastifyZod, deps: { limiter: RateLimiter }): void {
  app.decorateRequest('apiKey', null);
  app.decorateRequest('websitePaging', null);
  app.decorate(
    'requireApiKey',
    (scope: ApiKeyScope, options: RequireApiKeyOptions = {}) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        let principal: identity.ApiKeyPrincipal;
        try {
          principal = await identity.authenticateApiKey({ key: keyOf(request), origin: request.headers.origin, scope });
        } catch (err) {
          // Unknown keys are never cached, so guessing costs a query: cap failed checks per client IP.
          if (isAppError(err) && err.code === 'API_KEY_INVALID') {
            const failed = await deps.limiter.consume(identity.API_KEY_FAILURE_RULE, ipBucket(request.ip));
            if (!failed.allowed) return replyRateLimited(reply, 'ip', failed.retryAfterSeconds);
          }
          throw err;
        }
        request.apiKey = principal;
        // The key's tier, the agency's ceiling, burst, daily quota, per-browser limits (publishable keys) and the paging
        // rules (S7-04): one Redis round trip, decided in core.
        const decision = await websiteApi.checkWebsiteLimits(deps.limiter, principal, {
          ip: ipBucket(request.ip),
          paged: options.paged === true && cursorOf(request) !== undefined,
          listingsCursor: options.listings === true ? cursorOf(request) : undefined,
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
}

/** The `cursor` in the query string: the request continues a list (S7-04 paging rules). */
function cursorOf(request: FastifyRequest): string | undefined {
  const cursor = (request.query as Record<string, unknown> | undefined)?.cursor;
  return typeof cursor === 'string' && cursor !== '' ? cursor : undefined;
}
