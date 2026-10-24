import {
  CreateRegistrationBody,
  ListRegistrationsQuery,
  PageQuery,
  ReceivedRegistrationPage,
  RegistrationDto,
  RegistrationPage,
} from '@inmolink/contracts';
import * as mls from '@inmolink/core/modules/mls';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'mls.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'mls.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'mls.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'mls.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
  { name: 'mls.write.tenant', scope: 'tenant', limit: 1_000, windowSeconds: 3_600 },
];

const tags = ['mls'];

/**
 * MLS collaboration (PLAN §7 M10). S11-01, client registration: register a contact for another agency's listing or
 * development, the agency's registrations, and the ones other agencies made for its targets (never the client).
 * Registrations name clients: every answer is `no-store`.
 */
export async function mlsRoutes(app: FastifyZod): Promise<void> {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post(
    '/v1/mls/registrations',
    {
      schema: {
        tags,
        operationId: 'mls.registerClient',
        summary:
          'Register a contact for another agency’s listing or development (201); first valid registration wins. The agency’s own valid registration of the client answers as is (200)',
        body: CreateRegistrationBody,
        response: { 200: RegistrationDto, 201: RegistrationDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const result = await mls.registerClient((fn) => app.withCtx(req, fn), req.body);
      return reply.code(result.outcome === 'CREATED' ? 201 : 200).send(result.registration);
    },
  );

  app.get(
    '/v1/mls/registrations',
    {
      schema: {
        tags,
        operationId: 'mls.listRegistrations',
        summary: 'The agency’s client registrations with their clients, newest first',
        querystring: ListRegistrationsQuery,
        response: { 200: RegistrationPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.listRegistrations(ctx, req.query)),
  );

  app.get(
    '/v1/mls/received-registrations',
    {
      schema: {
        tags,
        operationId: 'mls.listReceivedRegistrations',
        summary:
          'Clients other agencies registered for the agency’s listings and developments: who and until when, never the client',
        querystring: PageQuery,
        response: { 200: ReceivedRegistrationPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.listReceivedRegistrations(ctx, req.query)),
  );
}
