import { metrics, trace } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { HTTP_DURATION_METRIC } from '../telemetry/names';

/** `http.route` of requests no route matched — one series, whatever the URL. */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * RED metrics and span names per route (S0-10). One histogram, `http.server.request.duration`
 * (seconds) by method, route template and status code: its count is the request rate, the 5xx share
 * the error rate, its buckets the latency. Route templates (`/v1/listings/:id`) keep cardinality bounded.
 * The HTTP server span gets the route as its name, plus the request id for log correlation.
 */
export function observeRequests(app: FastifyInstance): void {
  const duration = metrics.getMeter('@inmolink/platform').createHistogram(HTTP_DURATION_METRIC, {
    description: 'HTTP server request duration by route',
    unit: 's',
  });

  app.addHook('onRequest', async (request) => {
    const span = trace.getActiveSpan();
    if (!span) return;
    const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
    span.updateName(`${request.method} ${route}`);
    span.setAttributes({ 'http.route': route, 'inmolink.request_id': request.id });
  });

  app.addHook('onResponse', async (request, reply) => {
    duration.record(reply.elapsedTime / 1_000, {
      'http.request.method': request.method,
      'http.route': request.routeOptions.url ?? UNMATCHED_ROUTE,
      'http.response.status_code': reply.statusCode,
    });
  });
}
