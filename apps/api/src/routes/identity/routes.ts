import {
  ChangeMemberRoleBody,
  InviteDto,
  InviteMemberBody,
  InvitePage,
  InviteParams,
  MeDto,
  MemberDto,
  MemberPage,
  MemberParams,
  PageQuery,
} from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';
import { apiKeyRoutes } from './api-keys';

const ME_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.me.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'identity.me.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const TEAM_READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.team.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'identity.team.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const TEAM_WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.team.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'identity.team.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
];
// Each invite sends an email: capped per agency too, so one tenant cannot use us to spam.
const INVITE_LIMITS: readonly RateLimitRule[] = [
  ...TEAM_WRITE_LIMITS,
  { name: 'identity.invite.tenant', scope: 'tenant', limit: 100, windowSeconds: 3_600 },
  { name: 'identity.invite.user.day', scope: 'user', limit: 50, windowSeconds: 86_400 },
];

/**
 * Identity routes. Sign-up, login, resets and invite acceptance run in the web app (Auth.js, anonymous);
 * the API verifies tokens and serves team management (S1-02) and website API keys (S1-05).
 */
export async function identityRoutes(app: FastifyZod): Promise<void> {
  await apiKeyRoutes(app);

  app.get(
    '/v1/me',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.getMe',
        summary: 'Who the access token belongs to',
        response: { 200: MeDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: ME_LIMITS },
    },
    // Read straight from the verified token: no database round trip.
    async (request) => identity.getMe(request.auth as NonNullable<typeof request.auth>),
  );

  app.get(
    '/v1/members',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.listMembers',
        summary: "The caller's team, oldest first (cursor pagination)",
        querystring: PageQuery,
        response: { 200: MemberPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: TEAM_READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => identity.listMembers(ctx, req.query)),
  );

  app.put(
    '/v1/members/:userId/role',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.changeMemberRole',
        summary: "Change a member's role (agency admins; never their own)",
        params: MemberParams,
        body: ChangeMemberRoleBody,
        response: { 200: MemberDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: TEAM_WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => identity.changeMemberRole(ctx, { ...req.params, ...req.body })),
  );

  app.post(
    '/v1/members/:userId/deactivate',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.deactivateMember',
        summary: 'Deactivate a member: no more logins, sessions revoked (agency admins; never themselves)',
        params: MemberParams,
        response: { 200: MemberDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: TEAM_WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => identity.deactivateMember(ctx, req.params)),
  );

  app.get(
    '/v1/invites',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.listInvites',
        summary: 'Open invites of the caller’s agency (agency admins)',
        querystring: PageQuery,
        response: { 200: InvitePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: TEAM_READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => identity.listInvites(ctx, req.query)),
  );

  app.post(
    '/v1/invites',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.inviteMember',
        summary: 'Invite someone by email with a role (7-day, single-use link; agency admins)',
        body: InviteMemberBody,
        response: { 201: InviteDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: INVITE_LIMITS },
    },
    async (req, reply) => reply.code(201).send(await app.withCtx(req, (ctx) => identity.inviteMember(ctx, req.body))),
  );

  app.delete(
    '/v1/invites/:inviteId',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.revokeInvite',
        summary: 'Withdraw an open invite (agency admins)',
        params: InviteParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: TEAM_WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) => identity.revokeInvite(ctx, req.params));
      return reply.code(204).send(null);
    },
  );
}
