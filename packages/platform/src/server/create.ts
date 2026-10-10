import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import fastifySwagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from '@fastify/type-provider-zod';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { newId, requestIdFrom } from '../ids';
import { type Logger, stripQuery } from '../logger';
import { registerErrorHandling, sendError } from './errors';
import { observeRequests } from './observe';

/** A Fastify instance with the Zod type provider — what route plugins receive (PATTERNS §10). */
export type FastifyZod = FastifyInstance<Server, IncomingMessage, ServerResponse, FastifyBaseLogger, ZodTypeProvider>;

export interface Lifecycle {
  /** Set first by graceful shutdown: `/readyz` fails and responses close their keep-alive socket. */
  draining: boolean;
  /** Set when the server closes: new requests get 503 while in-flight ones finish. */
  closing: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    lifecycle: Lifecycle;
  }
}

export interface ServerOptions {
  logger: Logger;
  /** From `httpEnv.TRUST_PROXY` — never `true`. */
  trustProxy: false | number | string[];
  /** From `httpEnv.EDGE_REQUEST_ID_HEADER`; without it every request gets a fresh id. */
  edgeRequestIdHeader?: string;
  /** OpenAPI document info; the spec is always built (SDK generation), `/docs` only when `docsUi`. */
  openapi: { title: string; version: string };
  /** Serve Swagger UI at `/docs` — development only. */
  docsUi?: boolean;
  /**
   * Level of the per-request line for 1xx–3xx responses (default `info`). feed-api uses `debug`:
   * ~1,000 lines/s per node at budget is noise; 4xx stay `info`, 5xx `error`.
   */
  successLogLevel?: 'info' | 'debug';
  /** Max request body in bytes (default 1 MiB). Upload routes raise it per route. */
  bodyLimit?: number;
}

const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Fastify with the Inmolink plumbing (PLAN §5.2): Zod validation + serialization, request ids,
 * the standard error body, OpenAPI, request logs without query strings, per-route RED metrics and span
 * names, 5xx reported to Sentry, and a draining gate for graceful shutdown. Apps add rate limits, auth and routes on top.
 */
export async function createServer(options: ServerOptions): Promise<FastifyZod> {
  const edgeHeader = options.edgeRequestIdHeader;
  const successLevel = options.successLogLevel ?? 'info';
  const app = Fastify({
    loggerInstance: options.logger as FastifyBaseLogger,
    // Fastify's own request lines log the full URL (query strings carry tokens); onResponse logs instead.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
    trustProxy: trustProxyOption(options.trustProxy),
    bodyLimit: options.bodyLimit ?? 1_048_576,
    // Only the edge's header is trusted for correlation (S0-03 decision); Fastify must not read x-request-id.
    requestIdHeader: false,
    genReqId: (req) => {
      const inbound = edgeHeader ? req.headers[edgeHeader] : undefined;
      return typeof inbound === 'string' ? requestIdFrom(inbound) : newId();
    },
    return503OnClosing: false,
    routerOptions: { ignoreTrailingSlash: true },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('lifecycle', { draining: false, closing: false });
  registerErrorHandling(app);
  observeRequests(app);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    const clientId = request.headers['x-request-id'];
    if (typeof clientId === 'string' && clientId !== request.id && CLIENT_REQUEST_ID.test(clientId)) {
      request.log = request.log.child({ clientRequestId: clientId });
    }
    const path = stripQuery(request.url);
    if (app.lifecycle.closing && path !== '/readyz' && path !== '/healthz') {
      reply.header('connection', 'close');
      return sendError(reply, 'SERVICE_UNAVAILABLE');
    }
  });

  // While draining, keep-alive sockets close after their response, so `close()` is not held open by
  // connections that turn idle after it started (Node closes only the ones idle at that moment).
  app.addHook('onSend', async (_request, reply) => {
    if (app.lifecycle.draining) reply.header('connection', 'close');
  });

  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    const level = status === 503 ? 'warn' : status >= 500 ? 'error' : status >= 400 ? 'info' : successLevel;
    request.log[level](
      {
        method: request.method,
        url: stripQuery(request.url),
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: options.openapi.title, version: options.openapi.version },
      servers: [],
    },
    transform: jsonSchemaTransform,
  });
  // Dev-only, so production processes never load it.
  if (options.docsUi) await app.register((await import('@fastify/swagger-ui')).default, { routePrefix: '/docs' });

  return app;
}

/** A hop count becomes "trust the nearest n proxies" (what proxy-addr does for a number). */
function trustProxyOption(
  value: false | number | string[],
): boolean | string[] | ((addr: string, i: number) => boolean) {
  return typeof value === 'number' ? (_addr, i) => i < value : value;
}
