/** Liveness for the orchestrator; Next drains in-flight requests on SIGTERM itself (`next start`). */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
