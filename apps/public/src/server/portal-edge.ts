import * as websiteApi from '@inmolink/core/modules/website-api';
import { publicConfig } from './env';

/**
 * S15-F11: the edge tag of a listing or development page (`/{locale}/property|development/{slug}`): core
 * `portalEdgeTag` of the public code its slug ends in, made with `HMAC_KEY` like the worker's purge
 * (`configureEdgeCache` in `env.ts`). Null: the slug names no code. One HMAC, no I/O after the first request.
 */
export async function portalItemEdgeTag(slug: string): Promise<string | null> {
  await publicConfig();
  const code = websiteApi.codeOfSlug(slug);
  return code ? websiteApi.portalEdgeTag(code) : null;
}
