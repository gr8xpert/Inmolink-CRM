import type { FastifyZod } from '@inmolink/platform/server';

/**
 * search dashboard routes (PATTERNS §10): request and response schemas from `@inmolink/contracts`,
 * `onRequest: [app.requireSession]`, and a one-expression handler:
 * `(req) => app.withCtx(req, (ctx) => search.someUseCase(ctx, req.body))`.
 */
export async function searchRoutes(_app: FastifyZod): Promise<void> {}
