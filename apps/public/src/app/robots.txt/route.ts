import { robotsResponse } from '@/portal/sitemaps';

/** The portal's robots.txt (S15-02): crawl everything public; the sitemap index. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return robotsResponse();
}
