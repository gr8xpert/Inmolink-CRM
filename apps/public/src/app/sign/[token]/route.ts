import { withSelectionHeaders } from '@/selections/handlers';
import { signingActionResponse, signingResponse } from '@/signing/handlers';

/** R2-05b: a signer's signing link — GET shows the document and the forms, POST asks for a code or signs. */
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ token: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  return withSelectionHeaders(() => signingResponse(request, token));
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  return withSelectionHeaders(() => signingActionResponse(request, token));
}
