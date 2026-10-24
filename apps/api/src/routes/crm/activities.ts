import {
  ActivityDto,
  ActivityPage,
  CreateActivityBody,
  CreateContactHeaders,
  ListActivitiesQuery,
} from '@inmolink/contracts';
import * as crm from '@inmolink/core/modules/crm';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.activities.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'crm.activities.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.activities.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'crm.activities.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'crm.activities.write.tenant', scope: 'tenant', limit: 5_000, windowSeconds: 3_600 },
];

const tags = ['crm'];

/**
 * CRM activity timeline (S10-04): a contact's, lead's or listing's activities (or the agency's feed), and calls,
 * e-mails, meetings and viewings logged by hand. Registered inside `crmRoutes` (its `no-store` hook applies).
 */
export async function crmActivityRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/crm/activities',
    {
      schema: {
        tags,
        operationId: 'crm.listActivities',
        summary:
          'The activity timeline of a contact, lead or listing (subject + subjectId) or of the agency, newest first; filters by type',
        querystring: ListActivitiesQuery,
        response: { 200: ActivityPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listActivities(ctx, req.query)),
  );

  app.post(
    '/v1/crm/activities',
    {
      schema: {
        tags,
        operationId: 'crm.createActivity',
        summary:
          'Log a call, e-mail, meeting or viewing about a contact, lead or listing (201). With an Idempotency-Key, a retry within 24 h answers the first activity (200)',
        headers: CreateContactHeaders,
        body: CreateActivityBody,
        response: { 201: ActivityDto, 200: ActivityDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        crm.logActivity(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.activity);
    },
  );
}
