import { detailResponse, leadResponse } from '@/embed/handlers';

/** iFrame embed detail and its enquiry form's post (S7-F8): server-rendered HTML, no framework JavaScript. */
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ site: string; lang: string; ref: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return detailResponse(request, await ctx.params);
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  return leadResponse(request, await ctx.params);
}
