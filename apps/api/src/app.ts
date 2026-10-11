import type { AccessTokenVerifier } from '@inmolink/platform/jwt';
import type { Logger } from '@inmolink/platform/logger';
import { ipBucket, type RateLimiter, type RateLimitRule, rateLimitPlugin } from '@inmolink/platform/rate-limit';
import { createServer, type FastifyZod, type HealthCheck, healthRoutes } from '@inmolink/platform/server';
import { ctxPlugin } from './plugins/ctx';
import { sessionPlugin } from './plugins/session';
import { agenciesRoutes } from './routes/agencies/routes';
import { billingRoutes } from './routes/billing/routes';
import { identityRoutes } from './routes/identity/routes';

/** Fastify dashboard API. Transport only — business logic lives in @inmolink/core. */
export const APP_NAME = 'api';

/** Routes without their own `config.rateLimit`. Per-user/tenant rules arrive with the routes that need them. */
export const DEFAULT_LIMITS: readonly RateLimitRule[] = [
  { name: 'api.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
];

export interface ApiDeps {
  logger: Logger;
  trustProxy: false | number | string[];
  edgeRequestIdHeader?: string;
  docsUi: boolean;
  checks: Record<string, HealthCheck>;
  /** Readiness result reuse (default 1 s); tests that swap dependencies pass 0. */
  readinessCacheMs?: number;
  limiter: RateLimiter;
  /** Access tokens from the web app (audience `api`). */
  verifier: AccessTokenVerifier;
}

export async function buildApp(deps: ApiDeps): Promise<FastifyZod> {
  const app = await createServer({
    logger: deps.logger,
    trustProxy: deps.trustProxy,
    edgeRequestIdHeader: deps.edgeRequestIdHeader,
    openapi: { title: 'Inmolink dashboard API', version: '2.0.0' },
    docsUi: deps.docsUi,
  });
  ctxPlugin(app);
  sessionPlugin(app, { verifier: deps.verifier });
  await app.register(rateLimitPlugin, {
    limiter: deps.limiter,
    defaults: DEFAULT_LIMITS,
    identify: {
      ip: (r) => ipBucket(r.ip),
      user: (r) => r.auth?.userId,
      tenant: (r) => r.auth?.agencyId ?? undefined,
    },
  });
  healthRoutes(app, { checks: deps.checks, cacheMs: deps.readinessCacheMs });
  await app.register(identityRoutes);
  await app.register(agenciesRoutes);
  await app.register(billingRoutes);
  return app;
}
