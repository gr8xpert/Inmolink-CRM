import { NetworkSearchBody, NetworkSearchResult } from '@inmolink/contracts';
import * as search from '@inmolink/core/modules/search';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

/** Network search reads other agencies' inventory: per user and per agency, so it cannot be walked quickly. */
const NETWORK_LIMITS: readonly RateLimitRule[] = [
  { name: 'search.network.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'search.network.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'search.network.tenant', scope: 'tenant', limit: 5_000, windowSeconds: 3_600 },
];

/**
 * search dashboard routes (PATTERNS §10). Network search (S5-05) runs the engine between two short transactions
 * (`ctxRunner`), never inside one.
 */
export async function searchRoutes(app: FastifyZod): Promise<void> {
  app.post(
    '/v1/network/search',
    {
      schema: {
        tags: ['search'],
        operationId: 'search.searchNetwork',
        summary:
          'Network search: other agencies’ shared listings and new-build units with commission terms, behind give-to-get',
        body: NetworkSearchBody,
        response: { 200: NetworkSearchResult },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: NETWORK_LIMITS },
    },
    (req) => search.searchNetwork(app.ctxRunner(req), req.body),
  );
}
