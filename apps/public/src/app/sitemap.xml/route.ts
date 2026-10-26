import { PORTAL_SITEMAP_INDEX } from '@inmolink/core/modules/website-api';
import { sitemapResponse } from '@/portal/sitemaps';

/** The portal's sitemap index (S15-02): the stored file the worker wrote, streamed. */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return sitemapResponse(request, PORTAL_SITEMAP_INDEX);
}
