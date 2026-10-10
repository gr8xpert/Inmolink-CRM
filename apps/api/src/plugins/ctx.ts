import { type Ctx, type RequestCtx, withRequestCtx } from '@inmolink/core';
import { AppError } from '@inmolink/platform/errors';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyRequest } from 'fastify';

/** Who is calling, set by `requireSession` in `onRequest`, so rate limits see it too. */
export interface RequestAuth {
  userId: string;
  /** `users.session_version` when the token was minted. */
  sessionVersion: number;
  tokenExpiresAt: Date;
  /** The caller's agency membership (tenant, role, locale) — null until memberships exist (S1-01). */
  member: Omit<RequestCtx, 'requestId'> | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
  interface FastifyInstance {
    /**
     * Builds `ctx` for the caller, opens `withTenant` and runs `fn` (PATTERNS §10). Errors propagate
     * to the error handler, which maps `AppError` to the standard body.
     */
    withCtx<T>(request: FastifyRequest, fn: (ctx: Ctx) => Promise<T>): Promise<T>;
  }
}

export function ctxPlugin(app: FastifyZod): void {
  app.decorateRequest('auth', null);
  app.decorate('withCtx', <T>(request: FastifyRequest, fn: (ctx: Ctx) => Promise<T>): Promise<T> => {
    const auth = request.auth;
    if (!auth) return Promise.reject(new AppError('NOT_AUTHENTICATED'));
    // Tenant routes need an agency; a user without one (before S1-01 onboarding) cannot reach them.
    if (!auth.member) return Promise.reject(new AppError('FORBIDDEN', { reason: 'no_agency' }));
    return withRequestCtx({ ...auth.member, requestId: request.id }, fn);
  });
}
