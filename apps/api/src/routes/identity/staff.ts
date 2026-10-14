import {
  ImpersonationDto,
  ImpersonationParams,
  LiveImpersonationList,
  MemberPage,
  PageQuery,
  StaffMeDto,
  StartImpersonationBody,
  TenantParams,
} from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const STAFF_READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.identity.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.identity.read.user', scope: 'user', limit: 300, windowSeconds: 60 },
];
/** Every start is audited and bounded; a staff member has no reason to start dozens an hour. */
const IMPERSONATION_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.impersonation.ip', scope: 'ip', limit: 60, windowSeconds: 60 },
  { name: 'staff.impersonation.user', scope: 'user', limit: 30, windowSeconds: 3_600 },
];

/**
 * Staff console, identity side (S1-09): who the staff caller is, an agency's members, and impersonation.
 * `withStaffCtx`: 403 for anyone who is not active staff (tenant and impersonation tokens included).
 */
export async function staffIdentityRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/staff/me',
    {
      schema: {
        tags: ['staff'],
        operationId: 'identity.getStaffMe',
        summary: "The staff caller's role and open impersonation session",
        response: { 200: StaffMeDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_READ_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'identity.getStaffMe', (ctx) => identity.getStaffMe(ctx)),
  );

  app.get(
    '/v1/staff/agencies/:agencyId/members',
    {
      schema: {
        tags: ['staff'],
        operationId: 'identity.listAgencyMembers',
        summary: "An agency's members (deactivated included), oldest first",
        params: TenantParams,
        querystring: PageQuery,
        response: { 200: MemberPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_READ_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'identity.listAgencyMembers', (ctx) =>
        identity.listAgencyMembers(ctx, { ...req.params, ...req.query }),
      ),
  );

  app.post(
    '/v1/staff/impersonations',
    {
      schema: {
        tags: ['staff'],
        operationId: 'identity.startImpersonation',
        summary: 'Act as an active member of an agency, with a reason, for 5–60 minutes (audited)',
        body: StartImpersonationBody,
        response: { 201: ImpersonationDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: IMPERSONATION_LIMITS },
    },
    async (req, reply) => {
      const dto = await app.withStaffCtx(req, 'identity.startImpersonation', (ctx) =>
        identity.startImpersonation(ctx, req.body),
      );
      return reply.code(201).send(dto);
    },
  );

  app.get(
    '/v1/staff/impersonations',
    {
      schema: {
        tags: ['staff'],
        operationId: 'identity.listLiveImpersonations',
        summary: "Every staff member's live impersonation session (super admins)",
        response: { 200: LiveImpersonationList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withStaffCtx(req, 'identity.listLiveImpersonations', (ctx) => identity.listLiveImpersonations(ctx));
    },
  );

  app.post(
    '/v1/staff/impersonations/:id/end',
    {
      schema: {
        tags: ['staff'],
        operationId: 'identity.endImpersonation',
        summary: "End an impersonation session: the caller's own, or any for a super admin (audited)",
        params: ImpersonationParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: IMPERSONATION_LIMITS },
    },
    async (req, reply) => {
      await app.withStaffCtx(req, 'identity.endImpersonation', (ctx) => identity.endImpersonation(ctx, req.params));
      return reply.code(204).send(null);
    },
  );
}
