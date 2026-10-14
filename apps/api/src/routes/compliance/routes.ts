import { AuditLogPage, PageQuery, StaffAuditPage, StaffAuditQuery } from '@inmolink/contracts';
import { listStaffAuditLog } from '@inmolink/core';
import * as compliance from '@inmolink/core/modules/compliance';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'compliance.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'compliance.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const STAFF_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.audit.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.audit.user', scope: 'user', limit: 120, windowSeconds: 60 },
];

/** compliance dashboard routes (PATTERNS §10): the agency's audit log (S1-08) and the staff viewer (S1-09). */
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

  app.get(
    '/v1/staff/audit-logs',
    {
      schema: {
        tags: ['staff'],
        operationId: 'compliance.listAuditLogForStaff',
        summary: 'Every agency’s audit log (or one), newest first, with both actors; the read is audited',
        querystring: StaffAuditQuery,
        response: { 200: StaffAuditPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withStaffCtx(req, 'compliance.listAuditLogForStaff', (ctx) => listStaffAuditLog(ctx, req.query));
    },
  );
}
