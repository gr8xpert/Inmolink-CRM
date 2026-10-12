import { AgencyDto, UpdateAgencyDetailsBody } from '@inmolink/contracts';
import * as agencies from '@inmolink/core/modules/agencies';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { preferredAgencyRoutes } from './preferred';
import { settingsRoutes } from './settings';
import { verificationRoutes } from './verification';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'agencies.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'agencies.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'agencies.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'agencies.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
];

/** The caller's own agency (S1-01): read it, and fill in the company details (onboarding). */
export async function agenciesRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/agency',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.getMyAgency',
        summary: "The caller's agency",
        response: { 200: AgencyDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => agencies.getMyAgency(ctx)),
  );

  app.put(
    '/v1/agency/details',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.updateAgencyDetails',
        summary: 'Save the company details (onboarding): name, CIF/NIF, address, region, languages',
        body: UpdateAgencyDetailsBody,
        response: { 200: AgencyDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => agencies.updateAgencyDetails(ctx, req.body)),
  );

  // Own plugins: their binary body parsers stay out of the other agencies routes.
  await app.register(verificationRoutes);
  await app.register(settingsRoutes);
  await app.register(preferredAgencyRoutes);
}
