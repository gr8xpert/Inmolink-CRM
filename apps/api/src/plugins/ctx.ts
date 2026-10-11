import { type Ctx, withMemberCtx } from '@inmolink/core';
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
}
