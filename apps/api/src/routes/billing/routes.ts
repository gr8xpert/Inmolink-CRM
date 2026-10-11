import type { FastifyZod } from '@inmolink/platform/server';

/**
 * billing dashboard routes (PATTERNS §10): request and response schemas from `@inmolink/contracts`,
 * `onRequest: [app.requireSession]`, and a one-expression handler:
 * `(req) => app.withCtx(req, (ctx) => billing.someUseCase(ctx, req.body))`.
 */
export async function billingRoutes(_app: FastifyZod): Promise<void> {}
