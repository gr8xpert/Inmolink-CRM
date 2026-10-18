import {
  SetGiveToGetExemptionBody,
  TenantDetailDto,
  TenantListQuery,
  TenantPage,
  TenantParams,
} from '@inmolink/contracts';
import * as agencies from '@inmolink/core/modules/agencies';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const STAFF_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.tenants.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.tenants.user', scope: 'user', limit: 300, windowSeconds: 60 },
];

/** Staff console: tenants (S1-09). `withStaffCtx`: 403 for anyone who is not active staff. */
export async function tenantRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/staff/agencies',
    {
      schema: {
        tags: ['staff'],
        operationId: 'agencies.listTenants',
        summary: 'Agencies, newest first; filter by status, search by name or tax id',
        querystring: TenantListQuery,
        response: { 200: TenantPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'agencies.listTenants', (ctx) => agencies.listTenants(ctx, req.query)),
  );

  app.get(
    '/v1/staff/agencies/:agencyId',
    {
      schema: {
        tags: ['staff'],
        operationId: 'agencies.getTenant',
        summary: "One agency's company details and its latest verification request",
        params: TenantParams,
        response: { 200: TenantDetailDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'agencies.getTenant', (ctx) => agencies.getTenant(ctx, req.params)),
  );

  app.put(
    '/v1/staff/agencies/:agencyId/give-to-get',
    {
      schema: {
        tags: ['staff'],
        operationId: 'agencies.setGiveToGetExemption',
        summary: 'Exempt a buyer-only agency from give-to-get, or end the exemption (support; audited)',
        params: TenantParams,
        body: SetGiveToGetExemptionBody,
        response: { 200: TenantDetailDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'agencies.setGiveToGetExemption', (ctx) =>
        agencies.setGiveToGetExemption(ctx, { ...req.params, ...req.body }),
      ),
  );
}
