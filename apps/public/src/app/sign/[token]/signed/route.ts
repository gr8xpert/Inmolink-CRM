import { withSelectionHeaders } from '@/selections/handlers';
import { signingFileResponse } from '@/signing/handlers';

/** R2-05b: the signed document — a 303 to a 5-minute signed link once everyone signed (90 days). */
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ token: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  return withSelectionHeaders(() => signingFileResponse(request, token, 'signed'));
}
