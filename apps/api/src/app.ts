import type { AccessTokenVerifier } from '@inmolink/platform/jwt';
import type { Logger } from '@inmolink/platform/logger';
import { ipBucket, type RateLimiter, type RateLimitRule, rateLimitPlugin } from '@inmolink/platform/rate-limit';
import { createServer, type FastifyZod, type HealthCheck, healthRoutes } from '@inmolink/platform/server';
import { clientModePlugin } from './plugins/client-mode';
import { ctxPlugin } from './plugins/ctx';
import { noStorePlugin } from './plugins/no-store';
import { sessionPlugin } from './plugins/session';
import { adminRoutes } from './routes/admin/routes';
import { agenciesRoutes } from './routes/agencies/routes';
import { aiFeaturesRoutes } from './routes/ai-features/routes';
import { billingRoutes } from './routes/billing/routes';
import { chatRoutes } from './routes/chat/routes';
import { complianceRoutes } from './routes/compliance/routes';
import { crmRoutes } from './routes/crm/routes';
import { developmentsRoutes } from './routes/developments/routes';
import { documentsRoutes } from './routes/documents/routes'; // S12-05
import { exportsRoutes } from './routes/exports/routes';
import { identityRoutes } from './routes/identity/routes';
import { importsRoutes } from './routes/imports/routes';
import { staffImportsRoutes } from './routes/imports/staff';
import { matchingRoutes } from './routes/matching/routes';
import { mediaRoutes } from './routes/media/routes';
import { mlsRoutes } from './routes/mls/routes';
import { networkRoutes } from './routes/network/routes';
import { notificationsRoutes } from './routes/notifications/routes';
import { onboardingRoutes } from './routes/onboarding/routes';
import { presentationsRoutes } from './routes/presentations/routes';
import { propertiesRoutes } from './routes/properties/routes';
import { qualityRoutes } from './routes/quality/routes';
import { searchRoutes } from './routes/search/routes';
import { socialRoutes } from './routes/social/routes';
import { supportRoutes } from './routes/support/routes';
import { taxonomyRoutes } from './routes/taxonomy/routes';
import { staffTaxonomyRoutes } from './routes/taxonomy/staff';
import { websitesRoutes } from './routes/websites/routes';

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
  // S12-06: first, so its route list and its Client Mode response net cover every route.
  clientModePlugin(app);
  // S13 review: `Cache-Control: no-store` on every private answer (always on `/v1/staff/*`), before the routes.
  noStorePlugin(app);
  ctxPlugin(app);
  sessionPlugin(app, { verifier: deps.verifier });
  await app.register(rateLimitPlugin, {
    limiter: deps.limiter,
    defaults: DEFAULT_LIMITS,
    identify: {
      ip: (r) => ipBucket(r.ip),
      // Staff acting as a member count against their own bucket (`act ?? sub`, S2-F2): they neither use up
      // the member's quota nor go uncounted.
      user: (r) => r.auth?.impersonation?.staffUserId ?? r.auth?.userId,
      tenant: (r) => r.auth?.agencyId ?? undefined,
    },
  });
  healthRoutes(app, { checks: deps.checks, cacheMs: deps.readinessCacheMs });
  await app.register(identityRoutes);
  await app.register(agenciesRoutes);
  await app.register(billingRoutes, { limiter: deps.limiter });
  await app.register(complianceRoutes);
  await app.register(taxonomyRoutes);
  await app.register(staffTaxonomyRoutes);
  await app.register(propertiesRoutes);
  await app.register(mediaRoutes);
  await app.register(qualityRoutes);
  await app.register(developmentsRoutes);
  await app.register(searchRoutes);
  await app.register(importsRoutes);
  await app.register(staffImportsRoutes);
  await app.register(websitesRoutes);
  await app.register(exportsRoutes);
  await app.register(crmRoutes);
  await app.register(documentsRoutes); // S12-05
  await app.register(mlsRoutes);
  await app.register(notificationsRoutes);
  await app.register(chatRoutes);
  await app.register(networkRoutes);
  await app.register(aiFeaturesRoutes);
  await app.register(matchingRoutes);
  await app.register(socialRoutes);
  await app.register(presentationsRoutes);
  await app.register(adminRoutes);
  await app.register(supportRoutes);
  await app.register(onboardingRoutes);
  return app;
}
