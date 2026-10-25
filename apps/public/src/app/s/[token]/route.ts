import { selectionActionResponse, selectionResponse } from '@/selections/handlers';

/** A selection's live page and its like / enquiry form posts (S12-04): server-rendered HTML, no JavaScript. */
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ token: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return selectionResponse(request, (await ctx.params).token);
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  return selectionActionResponse(request, (await ctx.params).token);
}
