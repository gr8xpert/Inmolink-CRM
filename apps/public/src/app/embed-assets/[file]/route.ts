import { EMBED_SCRIPT, EMBED_SCRIPT_PATH } from '@/embed/client';

/**
 * The embed pages' script (S7-F8) from 'self': content-hashed name, so it is cached for a year (`immutable`); any other
 * name is a 404.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params;
  if (`/embed-assets/${file}` !== EMBED_SCRIPT_PATH) return new Response(null, { status: 404 });
  return new Response(EMBED_SCRIPT, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
