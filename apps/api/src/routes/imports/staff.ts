import {
  FeedConnectionParams,
  ImportHealthDto,
  StaffResumeFeedConnectionBody,
  StaffResumeFeedConnectionDto,
} from '@inmolink/contracts';
import * as imports from '@inmolink/core/modules/imports';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.imports.read.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'staff.imports.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.imports.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'staff.imports.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
];

const tags = ['staff', 'imports'];

/**
 * Staff import health (S6-08): the dashboard's numbers and the resume action for connections the anomaly guard
 * paused. `withStaffCtx` answers 403 to anyone who is not active staff; resuming is for data ops and super admins and
 * is audited. Never cached.
 */
export async function staffImportsRoutes(app: FastifyZod): Promise<void> {
  const staff = [app.requireSession];

  app.get(
    '/v1/staff/imports/health',
    {
      schema: {
        tags,
        operationId: 'imports.staffGetImportHealth',
        summary: 'Feed runs of the last 24 h, failures by code, queue lag, paused connections, unmatched values',
        response: { 200: ImportHealthDto },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withStaffCtx(req, 'imports.staffGetImportHealth', (ctx) => imports.getImportHealth(ctx));
    },
  );

  app.post(
    '/v1/staff/imports/connections/:id/resume',
    {
      schema: {
        tags,
        operationId: 'imports.staffResumeFeedConnection',
        summary:
          'Resume a feed the anomaly guard paused, with a reason (kept for staff, not audited as text); acceptChange lets the next run skip the guard once',
        params: FeedConnectionParams,
        body: StaffResumeFeedConnectionBody,
        response: { 200: StaffResumeFeedConnectionDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withStaffCtx(req, 'imports.staffResumeFeedConnection', (ctx) =>
        imports.staffResumeFeedConnection(ctx, req.params.id, req.body),
      );
    },
  );
}
