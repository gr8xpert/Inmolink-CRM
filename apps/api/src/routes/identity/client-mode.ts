import { StartClientModeBody, StartClientModeDto } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

// Each start hashes a PIN (Argon2id): a few a minute per member is plenty.
const CLIENT_MODE_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.client-mode.start.ip', scope: 'ip', limit: 60, windowSeconds: 60 },
  { name: 'identity.client-mode.start.user', scope: 'user', limit: 10, windowSeconds: 60 },
];

/**
 * Client Mode (S12-06): the web app's "show to a client" button. Leaving it needs the PIN and runs in the web
 * session (Auth.js, `identity.checkClientModePin`): the API only ever sees tokens with or without `cm`.
 */
export async function clientModeRoutes(app: FastifyZod): Promise<void> {
  app.post(
    '/v1/session/client-mode',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.startClientMode',
        summary: 'Start Client Mode: the PIN that ends it; returns the signed hand-over for the web session',
        body: StartClientModeBody,
        response: { 200: StartClientModeDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: CLIENT_MODE_LIMITS },
    },
    async (req, _reply) => {
      return app.withCtx(req, (ctx) => identity.startClientMode(ctx, req.body));
    },
  );
}
