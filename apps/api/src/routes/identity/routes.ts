import { MeDto } from '@inmolink/contracts';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const ME_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.me.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'identity.me.user', scope: 'user', limit: 120, windowSeconds: 60 },
];

/** Identity routes. Sign-up, login and resets run in the web app (Auth.js); the API only verifies tokens. */
export async function identityRoutes(app: FastifyZod): Promise<void> {
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
    async (request) => {
      const auth = request.auth as NonNullable<typeof request.auth>;
      return {
        userId: auth.userId,
        agencyId: auth.member?.tenant.agencyId ?? null,
        sessionVersion: auth.sessionVersion,
        tokenExpiresAt: auth.tokenExpiresAt.toISOString(),
      };
    },
  );
}
