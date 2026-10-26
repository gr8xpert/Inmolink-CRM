import { sitemapResponse } from '@/portal/sitemaps';

/** One of the portal's sitemap files (S15-02): `/sitemaps/<locale>-<part>-<n>.xml`, streamed from storage. */
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ file: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return sitemapResponse(request, (await ctx.params).file);
}
