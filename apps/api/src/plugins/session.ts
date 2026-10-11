import { AppError, isAppError } from '@inmolink/platform/errors';
import type { AccessTokenVerifier } from '@inmolink/platform/jwt';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Route `onRequest` hook (PATTERNS §10): verifies the `Authorization: Bearer` access token
     * (audience `api`) and sets `request.auth`, before the per-user / per-tenant rate limits run in
     * `preHandler`. Missing, expired, wrong-audience or forged tokens → 401 NOT_AUTHENTICATED.
     */
    requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * Bearer tokens only — the API never reads cookies, so cross-site requests cannot ride a session (no
 * CSRF surface). Tokens come from the web app (`/session/token`), 15 minutes each.
 */
export function sessionPlugin(app: FastifyZod, options: { verifier: AccessTokenVerifier }): void {
  app.decorate('requireSession', async (request: FastifyRequest, reply: FastifyReply) => {
    const match = BEARER.exec(request.headers.authorization ?? '');
    try {
      if (!match?.[1]) throw new AppError('NOT_AUTHENTICATED', { reason: 'missing' });
      const claims = await options.verifier.verify(match[1], 'api');
      request.auth = {
        userId: claims.sub,
        sessionVersion: claims.sv,
        tokenExpiresAt: new Date(claims.exp * 1_000),
        agencyId: claims.agency ?? null,
      };
    } catch (err) {
      reply.header('www-authenticate', 'Bearer error="invalid_token"');
      if (!isAppError(err) || err.code !== 'NOT_AUTHENTICATED') throw err;
      // The reason (expired, unknown key, wrong audience, …) helps a forger more than a client: log it,
      // send the same body for every failure (S1-F5).
      request.log.info({ reason: err.details?.reason }, 'access token refused');
      throw new AppError('NOT_AUTHENTICATED');
    }
  });
}
