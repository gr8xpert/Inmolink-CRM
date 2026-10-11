import type { ApiKeyScope } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { ipBucket, type RateLimiter, replyRateLimited } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** The website API caller, set by `requireApiKey`; null on routes without it. */
    apiKey: identity.ApiKeyPrincipal | null;
  }
  interface FastifyInstance {
    /**
     * `onRequest` hook for website API routes (S1-05, PATTERNS §11): authenticates the key sent as
     * `X-Api-Key` or `Authorization: Bearer`, checks the origin allowlist (publishable keys) and `scope`,
     * sets `request.apiKey` (so `scope: 'key'` rate rules see it), then applies the key's rate tier and the
     * agency's ceiling over all its keys. Failed checks count against the client IP (429 past the limit).
     */
    requireApiKey(
      scope: ApiKeyScope,
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
  app.decorate('requireApiKey', (scope: ApiKeyScope) => async (request: FastifyRequest, reply: FastifyReply) => {
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
    // The key's tier, and the agency's ceiling over all its keys.
    const checks = await Promise.all([
      deps.limiter
        .consume(identity.apiKeyRateRule(principal.rateTier), principal.keyId)
        .then((r) => ({ r, scope: 'key' as const })),
      deps.limiter
        .consume(identity.API_KEY_AGENCY_RULE, principal.agencyId)
        .then((r) => ({ r, scope: 'tenant' as const })),
    ]);
    const denied = checks.filter((c) => !c.r.allowed);
    if (denied.length > 0) {
      const worst = denied.reduce((a, b) => (b.r.retryAfterSeconds > a.r.retryAfterSeconds ? b : a));
      request.log.info({ scope: worst.scope, keyId: principal.keyId }, 'rate limited');
      return replyRateLimited(reply, worst.scope, worst.r.retryAfterSeconds);
    }
    return undefined;
  });
}
