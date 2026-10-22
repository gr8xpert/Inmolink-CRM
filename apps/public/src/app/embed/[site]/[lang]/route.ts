import { searchResponse } from '@/embed/handlers';

/** iFrame embed search and results (S7-F8): server-rendered HTML, no framework JavaScript (`embed/handlers.tsx`). */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: { params: Promise<{ site: string; lang: string }> },
): Promise<Response> {
  return searchResponse(request, await ctx.params);
}
