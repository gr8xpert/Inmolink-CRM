import type { Instrumentation } from 'next';

/**
 * Next.js instrumentation hook (S0-10): tracing and error reporting for the web server. The Node-only
 * setup lives in `instrumentation.node.ts`, so the edge runtime never loads the OpenTelemetry SDK.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation.node');
}

/** Server errors (render, route handlers, server actions) go to Sentry with the route. */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { reportRequestError } = await import('./instrumentation.node');
  reportRequestError(err, request, context);
};
