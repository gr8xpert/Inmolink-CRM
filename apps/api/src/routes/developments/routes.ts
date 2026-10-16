import type { FastifyZod } from '@inmolink/platform/server';

/**
 * developments dashboard routes (PATTERNS §10): request and response schemas from `@inmolink/contracts`,
 * `onRequest: [app.requireSession]`, and a one-expression handler:
 * `(req) => app.withCtx(req, (ctx) => developments.someUseCase(ctx, req.body))`.
 */
export async function developmentsRoutes(_app: FastifyZod): Promise<void> {}
