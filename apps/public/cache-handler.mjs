// S15-F7: Next.js's ISR page cache for the public app (`cacheHandler` in next.config.ts) — pages in a byte-capped
// in-process LRU (`cacheMaxMemorySize`), dropped on every instance when the worker marks their cache tags changed on
// redis-cache (`@inmolink/platform/cache` `PageCacheHandler`; tags from core `website-api/portal-cache.ts`). Loaded
// by Next at runtime, uncompiled: plain ESM.
export { PageCacheHandler as default } from '@inmolink/platform/cache';
