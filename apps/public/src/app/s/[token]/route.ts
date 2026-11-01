import { selectionActionResponse, selectionResponse, withSelectionHeaders } from '@/selections/handlers';

/** A selection's live page and its like / enquiry form posts (S12-04): server-rendered HTML, no JavaScript. */
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ token: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  return withSelectionHeaders(() => selectionResponse(request, token));
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  return withSelectionHeaders(() => selectionActionResponse(request, token));
}
