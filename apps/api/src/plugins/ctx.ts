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
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
  interface FastifyInstance {
    /**
     * Opens `withTenant` for the caller's agency, builds `ctx` (role and verification read from the
     * database, S1-01) and runs `fn` (PATTERNS §10). Errors propagate
     * to the error handler, which maps `AppError` to the standard body.
     */
    withCtx<T>(request: FastifyRequest, fn: (ctx: Ctx) => Promise<T>): Promise<T>;
    /** `withCtx` as a runner, for use cases that open more than one short transaction (uploads). */
    ctxRunner(request: FastifyRequest): CtxRunner;
    /**
     * Staff routes (S1-03): opens `withStaff` (`app_staff`), reads the caller's staff role from the
     * database and runs `fn`. Staff have no agency, so a token with an agency claim is refused, as is
     * a user who is not (or no longer) staff — 403 either way. `reason` names the use case (audit).
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
    return withMemberCtx({ userId: auth.userId, agencyId: auth.agencyId, requestId: request.id }, fn);
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
      if (auth.agencyId) return Promise.reject(new AppError('FORBIDDEN', { reason: 'not_staff' }));
      return withStaffCtx({ userId: auth.userId, requestId: request.id, reason }, fn);
    },
  );
}
