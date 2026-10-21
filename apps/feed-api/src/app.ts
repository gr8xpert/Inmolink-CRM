import type { Logger } from '@inmolink/platform/logger';
import { ipBucket, type RateLimiter, type RateLimitRule, rateLimitPlugin } from '@inmolink/platform/rate-limit';
import { createServer, type FastifyZod, type HealthCheck, healthRoutes } from '@inmolink/platform/server';
import { apiKeyPlugin } from './plugins/api-key';
import { websiteCors } from './plugins/site-response';
import { taxonomyRoutes } from './routes/taxonomy/routes';
import { websiteLeadRoutes } from './routes/website-api/leads';
import { websiteApiRoutes } from './routes/website-api/routes';

/** Website API (v1 shim, v2, XML feeds) — reads, plus website form intake (S7-05); isolated. Transport only. */
export const APP_NAME = 'feed-api';

/**
 * Per-IP ceiling for routes without their own rules. Most traffic arrives through the CDN, so the
 * origin sees few IPs. `requireApiKey` applies each key's rate tier (S1-05); routes may add `key` rules.
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
  apiKeyPlugin(app, { limiter: deps.limiter });
  websiteCors(app);
  await app.register(rateLimitPlugin, {
    limiter: deps.limiter,
    defaults: DEFAULT_LIMITS,
    identify: { ip: (r) => ipBucket(r.ip), key: (r) => r.apiKey?.keyId, tenant: (r) => r.apiKey?.agencyId },
  });
  healthRoutes(app, { checks: deps.checks });
  await app.register(taxonomyRoutes);
  await app.register(websiteApiRoutes);
  await app.register(websiteLeadRoutes);
  return app;
}
