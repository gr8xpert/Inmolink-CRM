import { AuditLogPage, PageQuery } from '@inmolink/contracts';
import * as compliance from '@inmolink/core/modules/compliance';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'compliance.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'compliance.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];

/** compliance dashboard routes (PATTERNS §10): the agency's audit log (S1-08). */
export async function complianceRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/agency/audit-log',
    {
      schema: {
        tags: ['compliance'],
        operationId: 'compliance.listAuditLog',
        summary: 'The agency’s audit log — logins, 2FA, roles, API keys, verification — newest first (admins)',
        querystring: PageQuery,
        response: { 200: AuditLogPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => compliance.listAuditLog(ctx, req.query)),
  );
}
