// S15-F7: Next.js's ISR page cache for the public app (`cacheHandler` in next.config.ts) — pages in a byte-capped
// in-process LRU (`cacheMaxMemorySize`), dropped on every instance when the worker marks their cache tags changed on
// redis-cache (`@inmolink/platform/cache` `PageCacheHandler`; tags from core `website-api/portal-cache.ts`). Loaded
// by Next at runtime, uncompiled: plain ESM.
//
// S16-F8: every stored page keeps its own script policy (the hashes of its inline scripts) in its headers, so each
// answer from it — the first included — carries a `script-src` that matches (`stored-page-policy.mjs`).
import { PageCacheHandler } from '@inmolink/platform/cache';
import { createLogger } from '@inmolink/platform/logger';
import { withStoredPageScriptPolicy } from './stored-page-policy.mjs';

const DEV = process.env.NODE_ENV === 'development';
let log;

export default class PortalPageCacheHandler extends PageCacheHandler {
  set(key, data, ctx) {
    const onCapped = (dropped) => {
      log ??= createLogger({ service: 'public', level: process.env.LOG_LEVEL ?? 'info' });
      // The cache key is a path (`/en/property/<slug>`): public, no visitor data.
      log.warn(
        { key, dropped },
        'page cache: script hash cap reached; the rest of the page’s inline scripts are refused',
      );
    };
    // S17-F2: flight pushes that are not the entry's own RSC payload get no hash (the browser refuses them)
    const onUnmatched = (unmatched, noRscData) => {
      log ??= createLogger({ service: 'public', level: process.env.LOG_LEVEL ?? 'info' });
      log.warn({ key, unmatched, noRscData }, 'page cache: inline flight data not in the stored RSC payload; refused');
    };
    return super.set(key, withStoredPageScriptPolicy(data, { dev: DEV, onCapped, onUnmatched }), ctx);
  }
}
