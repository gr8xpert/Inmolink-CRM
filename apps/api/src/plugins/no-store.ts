import type { FastifyZod } from '@inmolink/platform/server';

export const NO_STORE = 'no-store';

/**
 * `Cache-Control` for the whole dashboard API, in one place (S13 review). Every `/v1/*` answer is private: it is
 * `no-store` unless its route chose another policy itself (the taxonomy's `private, max-age` + ETag). Staff answers
 * (`/v1/staff/*`: support tickets with internal notes, an agency's onboarding, grants, queues) are `no-store` always,
 * whatever the route set. Errors included: a 401/403/404 is never stored either. Registered before the routes, so it
 * applies to all of them (module hooks and per-route headers are no longer needed).
 */
export function noStorePlugin(app: FastifyZod): void {
  app.addHook('onSend', async (request, reply) => {
    const path = request.url;
    if (path.startsWith('/v1/staff/')) {
      reply.header('cache-control', NO_STORE);
    } else if (path.startsWith('/v1/') && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', NO_STORE);
    }
  });
}
