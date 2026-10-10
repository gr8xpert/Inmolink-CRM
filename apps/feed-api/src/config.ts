import {
  type Config,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  httpEnv,
  loadConfigOrExit,
  portVar,
  redisEnv,
  searchEnv,
} from '@inmolink/platform/config';

/** Website API: `app_public` only (read models, PUBLIC_READ) — no `app_user`, no queue (PLAN §5.3 bulkheads). */
export const feedApiEnv = {
  ...coreEnv,
  ...httpEnv,
  FEED_API_PORT: portVar(4001),
  DATABASE_URL_APP_PUBLIC: databaseEnv.DATABASE_URL_APP_PUBLIC,
  REDIS_CACHE_URL: redisEnv.REDIS_CACHE_URL,
  // Readiness only; the search adapter brings a scoped search key (never the master key).
  MEILI_URL: searchEnv.MEILI_URL,
  ...cryptoEnv,
};
export type FeedApiConfig = Config<typeof feedApiEnv>;

export const loadFeedApiConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfigOrExit(feedApiEnv, { ...env, APP_ROLE: 'http' });
