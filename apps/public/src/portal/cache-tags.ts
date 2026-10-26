import { unstable_cache } from 'next/cache';

/**
 * S15-F7: names an ISR page's cache tags (core's `portalPageTags`: its listing or development and its agency). Next
 * collects the tags of every `unstable_cache` call in a render into the page's cache entry; this one caches nothing
 * of use (a constant) and exists for its tags. The page cache (`PageCacheHandler`, `cache-handler.mjs`) drops the
 * page when the worker marks one of them changed (`website-api/portal-cache.ts`).
 */
export async function tagPage(tags: readonly string[]): Promise<void> {
  if (tags.length === 0) return;
  await unstable_cache(async () => true, ['portal-page-tags', ...tags], { tags: [...tags] })();
}
