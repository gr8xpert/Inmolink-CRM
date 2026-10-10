import type { Logger } from '@inmolink/platform/logger';
import { ipBucket, type RateLimiter, type RateLimitRule, rateLimitPlugin } from '@inmolink/platform/rate-limit';
import { createServer, type FastifyZod, type HealthCheck, healthRoutes } from '@inmolink/platform/server';

/** Website API (v1 shim, v2, XML feeds) — read-only, isolated. Transport only. */
export const APP_NAME = 'feed-api';

/**
 * Per-IP ceiling for routes without their own rules. Most traffic arrives through the CDN, so the
 * origin sees few IPs; per-key and per-site rules arrive with `requireApiKey`.
 */
export const DEFAULT_LIMITS: readonly RateLimitRule[] = [
  { name: 'feed.ip', scope: 'ip', limit: 1_200, windowSeconds: 60 },
];

export interface FeedApiDeps {
  logger: Logger;
  trustProxy: false | number | string[];
  edgeRequestIdHeader?: string;
  docsUi: boolean;
  checks: Record<string, HealthCheck>;
  limiter: RateLimiter;
}

export async function buildApp(deps: FeedApiDeps): Promise<FastifyZod> {
  const app = await createServer({
    logger: deps.logger,
    trustProxy: deps.trustProxy,
    edgeRequestIdHeader: deps.edgeRequestIdHeader,
    openapi: { title: 'Inmolink website API', version: '2.0.0' },
    docsUi: deps.docsUi,
    successLogLevel: 'debug',
  });
  await app.register(rateLimitPlugin, {
    limiter: deps.limiter,
    defaults: DEFAULT_LIMITS,
    identify: { ip: (r) => ipBucket(r.ip) },
  });
  healthRoutes(app, { checks: deps.checks });
  return app;
}
