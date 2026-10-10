import { type Ctx, type RequestCtx, withRequestCtx } from '@inmolink/core';
import { AppError } from '@inmolink/platform/errors';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyRequest } from 'fastify';

/** Who is calling, set by `requireSession` (S0-09) in `onRequest`, so rate limits see it too. */
export type RequestAuth = Omit<RequestCtx, 'requestId'>;

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
    return withRequestCtx({ ...auth, requestId: request.id }, fn);
  });
}
