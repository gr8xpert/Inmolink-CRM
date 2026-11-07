import { withSelectionHeaders } from '@/selections/handlers';
import { unsubscribeActionResponse, unsubscribeResponse } from '@/unsubscribe/handlers';

/** R2-02g: a marketing e-mail's one-click unsubscribe link — GET confirms, POST (RFC 8058) unsubscribes. */
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ token: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  return withSelectionHeaders(() => unsubscribeResponse(request, token));
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  return withSelectionHeaders(() => unsubscribeActionResponse(request, token));
}
