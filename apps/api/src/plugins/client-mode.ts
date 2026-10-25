import { stripClientModeFields } from '@inmolink/contracts';
import { errorBody, type FastifyZod } from '@inmolink/platform/server';

/** A registered route (method and URL pattern), for the Client Mode contract test over all routes (S12-06). */
export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered after `clientModePlugin` (S12-06: the contract test enumerates them). */
    registeredRoutes: readonly RegisteredRoute[];
  }
}

/**
 * Routes whose non-JSON answers a Client Mode session may receive (reviewed: they carry nothing a client must not see).
 * None so far — every route Client Mode allows answers JSON.
 */
export const CLIENT_MODE_RAW_ROUTES: ReadonlySet<string> = new Set<string>();

/** At most this many changed paths per warning line (the field names say what a serializer forgot). */
const MAX_LOGGED_PATHS = 20;

/**
 * Client Mode response net (S12-06, PLAN §3 #56). Services decide what a session in Client Mode may do (policies
 * refuse all but a few reads) and their serializers drop commission, owner agency, internal notes and private fields
 * (`ctx.clientMode`). This hook is the safety net behind them, for every route at once: a successful JSON answer to a
 * Client Mode token is scanned for `CLIENT_MODE_STRIPPED_FIELDS` and any value one still holds is replaced — and
 * logged as a serializer bug, so it gets fixed where it belongs. Answers to other tokens are not touched.
 * Registered before the routes, so it applies to all of them.
 */
export function clientModePlugin(app: FastifyZod): void {
  const routes: RegisteredRoute[] = [];
  app.decorate('registeredRoutes', routes);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.auth?.clientMode) return payload;
    // Nothing to scan: no body (204, HEAD).
    if (payload === null || payload === undefined || payload === '') return payload;
    const json = String(reply.getHeader('content-type') ?? '').includes('json');
    // S12-06 review: fail closed — a body the net cannot read (a stream, a file, text) never reaches a Client Mode
    // session, unless its route is reviewed for it (`CLIENT_MODE_RAW_ROUTES`). Error bodies are scanned too.
    if (typeof payload !== 'string' || !json) {
      if (CLIENT_MODE_RAW_ROUTES.has(`${request.method} ${request.routeOptions.url}`)) return payload;
      (payload as { destroy?: () => void }).destroy?.();
      request.log.warn(
        { route: request.routeOptions.url, method: request.method },
        'client mode: unreadable response body refused by the net',
      );
      reply.code(403).header('content-type', 'application/json; charset=utf-8').removeHeader('etag');
      return JSON.stringify(errorBody('FORBIDDEN', { reason: 'client_mode' }));
    }
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      reply.code(403).removeHeader('etag');
      return JSON.stringify(errorBody('FORBIDDEN', { reason: 'client_mode' }));
    }
    const changed = stripClientModeFields(body);
    if (changed.length === 0) return payload;
    request.log.warn(
      { route: request.routeOptions.url, method: request.method, fields: changed.slice(0, MAX_LOGGED_PATHS) },
      'client mode: response field stripped by the net (fix the serializer)',
    );
    reply.removeHeader('etag');
    return JSON.stringify(body);
  });
}
