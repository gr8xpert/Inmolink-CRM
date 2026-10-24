import { ResponseTimeKpiDto, ResponseTimeQuery } from '@inmolink/contracts';
import * as crm from '@inmolink/core/modules/crm';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.kpi.read.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'crm.kpi.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];

/** CRM KPIs (S10-09). Registered inside `crmRoutes` (its `no-store` hook applies). */
export async function crmKpiRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/crm/kpis/response-time',
    {
      schema: {
        tags: ['crm'],
        operationId: 'crm.getResponseTimeKpi',
        summary:
          'Median time from a lead reaching the inbox to its first human response: the agency’s and per member, for a range of at most 92 days',
        querystring: ResponseTimeQuery,
        response: { 200: ResponseTimeKpiDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getResponseTimeKpi(ctx, req.query)),
  );
}
