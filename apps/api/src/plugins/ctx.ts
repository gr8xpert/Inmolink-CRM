import { type Ctx, type CtxRunner, type StaffCtx, withMemberCtx, withStaffCtx } from '@inmolink/core';
import { AppError } from '@inmolink/platform/errors';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyRequest } from 'fastify';

/** Who is calling, set by `requireSession` in `onRequest`, so rate limits see it too. */
export interface RequestAuth {
  userId: string;
  /** `users.session_version` when the token was minted. */
  sessionVersion: number;
  tokenExpiresAt: Date;
  /** The token's `agency` claim (the caller's tenant); null for users without an agency (staff). */
  agencyId: string | null;
  /**
   * Staff acting as `userId` (S1-09): the token's `imp` (session) and `act` (staff member) claims.
   * `withCtx` checks the session per request; staff routes refuse these tokens.
   */
  impersonation: { id: string; staffUserId: string } | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
  interface FastifyInstance {
    /**
     * Opens `withTenant` for the caller's agency, builds `ctx` (role and verification read from the
     * database, S1-01; an impersonated session checked and recorded, S1-09) and runs `fn` (PATTERNS
     * §10). Errors propagate to the error handler, which maps `AppError` to the standard body.
     */
    withCtx<T>(request: FastifyRequest, fn: (ctx: Ctx) => Promise<T>): Promise<T>;
    /** `withCtx` as a runner, for use cases that open more than one short transaction (uploads). */
    ctxRunner(request: FastifyRequest): CtxRunner;
    /**
     * Staff routes (S1-03): opens `withStaff` (`app_staff`), reads the caller's staff role from the
     * database and runs `fn`. Staff have no agency, so a token with an agency claim (a tenant's, or an
     * impersonation token) is refused, as is a user who is not (or no longer) staff — 403 either way.
     * `reason` names the use case (audit).
     */
    withStaffCtx<T>(request: FastifyRequest, reason: string, fn: (ctx: StaffCtx) => Promise<T>): Promise<T>;
  }
}

export function ctxPlugin(app: FastifyZod): void {
  app.decorateRequest('auth', null);
  app.decorate('withCtx', <T>(request: FastifyRequest, fn: (ctx: Ctx) => Promise<T>): Promise<T> => {
    const auth = request.auth;
    if (!auth) return Promise.reject(new AppError('NOT_AUTHENTICATED'));
    // Tenant routes need an agency; a user without one (staff) cannot reach them.
    if (!auth.agencyId) return Promise.reject(new AppError('FORBIDDEN', { reason: 'no_agency' }));
    if (auth.impersonation) {
      // One trace line per impersonated request (S1-09 review): ids and the route pattern only, no PII.
      request.log.info(
        {
          event: 'staff.impersonation.request',
          method: request.method,
          route: request.routeOptions.url,
          requestId: request.id,
          impersonationId: auth.impersonation.id,
          staffUserId: auth.impersonation.staffUserId,
          userId: auth.userId,
          agencyId: auth.agencyId,
        },
        'staff.impersonation.request',
      );
    }
    return withMemberCtx(
      {
        userId: auth.userId,
        agencyId: auth.agencyId,
        requestId: request.id,
        ...(auth.impersonation
          ? { impersonation: { ...auth.impersonation, sessionVersion: auth.sessionVersion } }
          : {}),
      },
      fn,
    );
  });
  app.decorate(
    'ctxRunner',
    (request: FastifyRequest): CtxRunner =>
      (fn) =>
        app.withCtx(request, fn),
  );
  app.decorate(
    'withStaffCtx',
    <T>(request: FastifyRequest, reason: string, fn: (ctx: StaffCtx) => Promise<T>): Promise<T> => {
      const auth = request.auth;
      if (!auth) return Promise.reject(new AppError('NOT_AUTHENTICATED'));
      if (auth.agencyId || auth.impersonation)
        return Promise.reject(new AppError('FORBIDDEN', { reason: 'not_staff' }));
      return withStaffCtx({ userId: auth.userId, requestId: request.id, reason }, fn);
    },
  );
}
