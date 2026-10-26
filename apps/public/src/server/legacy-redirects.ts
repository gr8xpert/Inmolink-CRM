import * as migration from '@inmolink/core/modules/migration';
import { localRedirectTarget } from '@/portal/redirect-target';
import { LOCAL_PUBLIC_URL, publicConfig } from './env';

/**
 * Legacy inmolink.es URLs (S15-02 → S14-05 `legacy_url_redirects`): the portal's redirect for a requested path (with
 * its query) and its status, or null. Core's resolver answers from its in-process cache (one indexed probe on a miss,
 * after `beforeProbe` — the caller's per-client limit) and counts the hit in memory; this process hands its counts to
 * the shared counters every `REDIRECT_HITS_PUSH_MS` (the worker writes them to the table: the public pages have no
 * role that may). The rows are keyed by the portal's own host (`PORTAL_URL`), never the request's `Host` header. A
 * target off the portal's origin is never answered.
 */
export async function legacyRedirect(
  pathWithQuery: string,
  beforeProbe?: () => Promise<boolean>,
): Promise<{ targetPath: string; status: 301 | 308 } | null> {
  const config = await publicConfig();
  startPushing();
  const host = new URL(config.PORTAL_URL ?? config.PUBLIC_URL ?? LOCAL_PUBLIC_URL).host;
  const found = await migration.resolveLegacyRedirect(
    'portal',
    host,
    pathWithQuery,
    beforeProbe ? { beforeProbe } : {},
  );
  const targetPath = localRedirectTarget(found?.targetPath);
  return found && targetPath ? { targetPath, status: found.status } : null;
}

let timer: ReturnType<typeof setInterval> | undefined;

function startPushing(): void {
  if (timer) return;
  timer = setInterval(() => {
    void migration.pushRedirectHits();
  }, migration.REDIRECT_HITS_PUSH_MS);
  // Never keeps the process alive; the last interval's hits are statistics, not data.
  timer.unref?.();
}
