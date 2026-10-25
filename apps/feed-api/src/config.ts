import {
  type Config,
  ConfigError,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  edgeCacheEnv,
  httpEnv,
  loadConfig,
  mediaCdnEnv,
  networkEnv,
  portVar,
  rateLimitEnv,
  redisEnv,
  searchEnv,
  siteFeedStorageEnv,
  telemetryEnv,
  turnstileEnv,
  websiteApiEnv,
  websiteSearchEnv,
} from '@inmolink/platform/config';
import { z } from 'zod';

/**
 * Website API: `app_public` for reads (read models, PUBLIC_READ) and `app_intake` for website forms (S7-05: inbound
 * leads and their outbox events only) — no `app_user`, and no queue except AI search's usage jobs when AI is on (S12-08;
 * PLAN §5.3 bulkheads).
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
  /**
   * S12-08: only with AI on (`AI_PROVIDER`, read by the AI gateway itself): AI search queues its usage records and
   * budget refreshes (`ai.recordUsage`, `ai.refreshSpend`) for the worker. Production: an ACL user that may only
   * enqueue those jobs.
   */
  REDIS_QUEUE_URL: redisEnv.REDIS_QUEUE_URL.optional(),
  /** Rate-limit counters only (S1-F6); production's ACL user reaches no queue key. */
  ...rateLimitEnv,
  // Readiness only; the search adapter brings a scoped search key (never the master key).
  MEILI_URL: searchEnv.MEILI_URL,
  /** Search-only key (S1-F5) — never the master key in a request app. */
  MEILI_SEARCH_KEY: searchEnv.MEILI_SEARCH_KEY,
  /** Development and test only, when no search key is set (refused for APP_ROLE=http in production). */
  MEILI_MASTER_KEY: searchEnv.MEILI_MASTER_KEY.optional(),
  /** Website search timing: engine timeout, slow threshold, circuit breaker (S6-F3). */
  ...websiteSearchEnv,
  /** Honeytokens on deep search pages of suspected scrapers (S7-04). */
  ...websiteApiEnv,
  /** Edge caching of first pages and details (S7-06): on only once the Cloudflare cache rules are live. */
  ...edgeCacheEnv,
  /** Image URLs in website documents (S7-03). */
  ...mediaCdnEnv,
  /** Per-site XML feeds (S7-07): read from the `exports` bucket only (`site-feeds/…`). */
  ...siteFeedStorageEnv,
  /** Give-to-get (S7-03): network listings on websites follow the network search's threshold and grace period. */
  NETWORK_GIVE_TO_GET_MIN_SHARED: networkEnv.NETWORK_GIVE_TO_GET_MIN_SHARED,
  NETWORK_GIVE_TO_GET_GRACE_DAYS: networkEnv.NETWORK_GIVE_TO_GET_GRACE_DAYS,
  /**
   * S9-03: portal feed requests per minute per IP. Portals crawl many agencies' feeds from a few addresses, and a
   * nightly regeneration purges them all, so the origin sees every feed of a portal from one address at once; the
   * per-token limit (60 / hour) protects each feed. Raise it for a portal that fetches more feeds than this per
   * minute.
   */
  PORTAL_FEED_IP_PER_MINUTE: z.coerce.number().int().min(60).max(100_000).default(3_000),
  /**
   * S12-08: how long `/v2/search/ai` waits for the model before answering with a keyword search (the answer still
   * fills the cache for the next visitor), and how long an understood sentence is kept. 500 ms keeps an uncached
   * request inside its p95 budget (600 ms) whatever the provider does.
   */
  SEARCH_AI_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(500),
  SEARCH_AI_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(90 * 86_400)
    .default(7 * 86_400),
  /**
   * S12-08 review: model calls (cache misses) per API key per minute, per browser (publishable keys) per minute, per
   * site per day; past them a keyword search answers. The agency's monthly calls are this feature's share of its AI
   * hard cap (basis points), in worst-case FAST calls.
   */
  SEARCH_AI_MISSES_PER_KEY_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
  SEARCH_AI_MISSES_PER_BROWSER_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
  SEARCH_AI_MISSES_PER_SITE_PER_DAY: z.coerce.number().int().min(1).max(10_000_000).default(5_000),
  SEARCH_AI_BUDGET_SHARE_BP: z.coerce.number().int().min(0).max(10_000).default(2_500),
  /** Model calls still running after their request answered, per process; beyond it no new one starts. */
  SEARCH_AI_MAX_LATE_CALLS: z.coerce.number().int().min(0).max(1_000).default(32),
  ...cryptoEnv,
};
export type FeedApiConfig = Config<typeof feedApiEnv>;

/**
 * S7-F9 security review: in production feed-api must name the proxies in front of it as an IP / CIDR allowlist
 * (`TRUST_PROXY`, Kamal: the `kamal` network and Cloudflare's ranges). Its keyed routes have no per-IP request limit
 * any more, so the client address must be the one the edge saw: `false` puts every visitor behind one proxy address,
 * and a hop count trusts whatever `X-Forwarded-For` a client sent to an address in front of the counted hops (a fresh
 * rate-limit bucket per request). Development and test keep the platform defaults.
 */
export function assertFeedApiTrustProxy(config: Pick<FeedApiConfig, 'NODE_ENV' | 'TRUST_PROXY'>): void {
  if (config.NODE_ENV !== 'production' || Array.isArray(config.TRUST_PROXY)) return;
  throw new ConfigError([
    {
      key: 'TRUST_PROXY',
      message: 'must list the proxy IPs / CIDRs in front of feed-api in production (no false, no hop count)',
    },
  ]);
}

/**
 * S9-03 review: in production feed-api reads site and portal feeds from their own bucket (`S3_BUCKET_FEEDS`,
 * `inmolink-feeds`, read-only token); the fallback to the exports bucket is for local stacks only.
 */
export function assertFeedApiFeedsBucket(config: Pick<FeedApiConfig, 'NODE_ENV' | 'S3_BUCKET_FEEDS'>): void {
  if (config.NODE_ENV !== 'production' || config.S3_BUCKET_FEEDS) return;
  throw new ConfigError([{ key: 'S3_BUCKET_FEEDS', message: 'must name the feeds bucket in production' }]);
}

/** feed-api's configuration, checked (`assertFeedApiTrustProxy`, `assertFeedApiFeedsBucket`); throws `ConfigError`. */
export function feedApiConfig(env: Record<string, string | undefined>): FeedApiConfig {
  const config = loadConfig(feedApiEnv, { ...env, APP_ROLE: 'http' });
  assertFeedApiTrustProxy(config);
  assertFeedApiFeedsBucket(config);
  return config;
}

/** For `main.ts`: prints the problems and exits with code 1. */
export function loadFeedApiConfig(env: Record<string, string | undefined> = process.env): FeedApiConfig {
  try {
    return feedApiConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`${err.message}
`);
    return process.exit(1);
  }
}
