import {
  type Config,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  httpEnv,
  loadConfigOrExit,
  portVar,
  rateLimitEnv,
  redisEnv,
  searchEnv,
  telemetryEnv,
} from '@inmolink/platform/config';

/** Website API: `app_public` only (read models, PUBLIC_READ) — no `app_user`, no queue (PLAN §5.3 bulkheads). */
export const feedApiEnv = {
  ...coreEnv,
  ...httpEnv,
  FEED_API_PORT: portVar(4001),
  /** Prometheus `/metrics` on `METRICS_HOST` (private); 0 turns it off. */
  FEED_API_METRICS_PORT: portVar(9465),
  ...telemetryEnv,
  DATABASE_URL_APP_PUBLIC: databaseEnv.DATABASE_URL_APP_PUBLIC,
  REDIS_CACHE_URL: redisEnv.REDIS_CACHE_URL,
  /** Rate-limit counters only (S1-F6); production's ACL user reaches no queue key. */
  ...rateLimitEnv,
  // Readiness only; the search adapter brings a scoped search key (never the master key).
  MEILI_URL: searchEnv.MEILI_URL,
  /** Search-only key (S1-F5) — never the master key in a request app. */
  MEILI_SEARCH_KEY: searchEnv.MEILI_SEARCH_KEY,
  ...cryptoEnv,
};
export type FeedApiConfig = Config<typeof feedApiEnv>;

export const loadFeedApiConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfigOrExit(feedApiEnv, { ...env, APP_ROLE: 'http' });
