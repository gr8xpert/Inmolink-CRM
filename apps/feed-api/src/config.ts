import {
  type Config,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  edgeCacheEnv,
  httpEnv,
  loadConfigOrExit,
  mediaCdnEnv,
  networkEnv,
  portVar,
  rateLimitEnv,
  redisEnv,
  searchEnv,
  telemetryEnv,
  turnstileEnv,
  websiteApiEnv,
  websiteSearchEnv,
} from '@inmolink/platform/config';

/**
 * Website API: `app_public` for reads (read models, PUBLIC_READ) and `app_intake` for website forms (S7-05: inbound
 * leads and their outbox events only) — no `app_user`, no queue (PLAN §5.3 bulkheads).
 */
export const feedApiEnv = {
  ...coreEnv,
  ...httpEnv,
  FEED_API_PORT: portVar(4001),
  /** Prometheus `/metrics` on `METRICS_HOST` (private); 0 turns it off. */
  FEED_API_METRICS_PORT: portVar(9465),
  ...telemetryEnv,
  DATABASE_URL_APP_PUBLIC: databaseEnv.DATABASE_URL_APP_PUBLIC,
  /** Website form intake (S7-05): required — feed-api's only write path. */
  DATABASE_URL_APP_INTAKE: databaseEnv.DATABASE_URL_APP_INTAKE.unwrap(),
  /** Cloudflare Turnstile (S7-05, H3): without it, forms through publishable keys are refused (fail closed). */
  ...turnstileEnv,
  REDIS_CACHE_URL: redisEnv.REDIS_CACHE_URL,
  /** Rate-limit counters only (S1-F6); production's ACL user reaches no queue key. */
  ...rateLimitEnv,
  // Readiness only; the search adapter brings a scoped search key (never the master key).
  MEILI_URL: searchEnv.MEILI_URL,
  /** Search-only key (S1-F5) — never the master key in a request app. */
  MEILI_SEARCH_KEY: searchEnv.MEILI_SEARCH_KEY,
  /** Website search timing: engine timeout, slow threshold, circuit breaker (S6-F3). */
  ...websiteSearchEnv,
  /** Honeytokens on deep search pages of suspected scrapers (S7-04). */
  ...websiteApiEnv,
  /** Edge caching of first pages and details (S7-06): on only once the Cloudflare cache rules are live. */
  ...edgeCacheEnv,
  /** Image URLs in website documents (S7-03). */
  ...mediaCdnEnv,
  /** Give-to-get (S7-03): network listings on websites follow the network search's threshold and grace period. */
  NETWORK_GIVE_TO_GET_MIN_SHARED: networkEnv.NETWORK_GIVE_TO_GET_MIN_SHARED,
  NETWORK_GIVE_TO_GET_GRACE_DAYS: networkEnv.NETWORK_GIVE_TO_GET_GRACE_DAYS,
  ...cryptoEnv,
};
export type FeedApiConfig = Config<typeof feedApiEnv>;

export const loadFeedApiConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfigOrExit(feedApiEnv, { ...env, APP_ROLE: 'http' });
