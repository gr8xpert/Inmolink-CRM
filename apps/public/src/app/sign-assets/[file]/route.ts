import { SIGNING_SCRIPT, SIGNING_SCRIPT_PATH } from '@/signing/client';

/**
 * The signing page's script (R2-05b) from 'self': content-hashed name, so it is cached for a year (`immutable`); any
 * other name is a 404.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params;
  if (`/sign-assets/${file}` !== SIGNING_SCRIPT_PATH) return new Response(null, { status: 404 });
  return new Response(SIGNING_SCRIPT, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
