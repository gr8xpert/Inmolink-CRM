import { closeDb, configureAiRuntime, configureDb, createOutboxDispatcher, loadStackEnv, pingDb } from '@inmolink/core';
import * as complianceWorker from '@inmolink/core/modules/compliance/worker';
import * as exportsWorker from '@inmolink/core/modules/exports/worker';
import * as identity from '@inmolink/core/modules/identity';
import * as imports from '@inmolink/core/modules/imports';
import * as media from '@inmolink/core/modules/media';
import * as mls from '@inmolink/core/modules/mls';
import * as search from '@inmolink/core/modules/search';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { configureCdn, createCloudflarePurger } from '@inmolink/platform/cdn';
import { hmacRotationFromEnv, keyringFromEnv } from '@inmolink/platform/crypto';
import { closeEmail, configureEmail } from '@inmolink/platform/email';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, producerConnection } from '@inmolink/platform/queue';
import { configureSearch, searchConfigFromEnv } from '@inmolink/platform/search';
import { gracefulShutdown, redisCheck } from '@inmolink/platform/server';
import { configureStorage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { reportError, startObservability } from '@inmolink/platform/telemetry';
import { startWorker } from './app';
import { emailConfig, loadWorkerConfig } from './config';
import { POOL_JOBS, POOL_OPTIONS } from './processors';
import { registerSubscriptions } from './subscriptions';

loadStackEnv('dev', { allowExample: false });
const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });
// Before any connection opens, so startup work is traced too. Port 0 = no /metrics endpoint.
const telemetry = startObservability(config, {
  service: 'worker',
  metricsPort: config.WORKER_METRICS_PORT || undefined,
});

try {
  // Pool-aware (S3-F4): a media-only container has `app_media` and storage, nothing else.
  const mediaOnly = config.WORKER_POOLS.every((p) => p === 'media');
  await configureDb(
    {
      APP_ROLE: 'worker',
      DATABASE_URL_APP_USER: config.DATABASE_URL_APP_USER,
      DATABASE_URL_APP_SYSTEM: config.DATABASE_URL_APP_SYSTEM,
      DATABASE_URL_APP_MEDIA: config.DATABASE_URL_APP_MEDIA,
      // S7-05: lead acknowledgements read the site's inventory as the website API does.
      DATABASE_URL_APP_PUBLIC: config.DATABASE_URL_APP_PUBLIC,
    },
    { logger },
  );
  await configureQueue({ url: config.REDIS_QUEUE_URL, logger });
  // A media-only container has no cache (S3-F7): nothing it runs reads or writes cached bodies.
  if (config.REDIS_CACHE_URL) await configureCache({ url: config.REDIS_CACHE_URL, logger });
  // S11-F13: the HMAC_KEY rotation window (opt-in stored-hash lookups accept HMAC_KEY_PREVIOUS until it ends).
  if (config.HMAC_KEY) hmacRotationFromEnv({ ...config, HMAC_KEY: config.HMAC_KEY }, logger);
  // The digest pool (S11 review) mails too.
  if (config.WORKER_POOLS.includes('email') || config.WORKER_POOLS.includes('digest')) {
    await configureEmail(emailConfig(config));
  }
  // S7-05: lead acknowledgements (email) and S7-07: per-site XML feeds (exports) serialize listings like the website
  // API (media CDN, white-label).
  if (
    (config.WORKER_POOLS.includes('email') || config.WORKER_POOLS.includes('exports')) &&
    config.HMAC_KEY &&
    config.MEDIA_CDN_URL
  ) {
    websiteApi.configureWebsiteApi({ mediaBaseUrl: config.MEDIA_CDN_URL, cursorKey: config.HMAC_KEY });
  }
  // S12-01: the AI gateway (ai pool) — tiers, prices and budgets from env; AI_PROVIDER=none keeps it switched off.
  if (config.WORKER_POOLS.includes('ai')) await configureAiRuntime({ logger });
  // S10-08: data exports (exports pool) — the media manifest's image URLs under the media CDN; the admins' alert
  // (email pool) links to the dashboard.
  if (config.WORKER_POOLS.includes('exports')) {
    complianceWorker.configureDataExport(config.MEDIA_CDN_URL ? { mediaBaseUrl: config.MEDIA_CDN_URL } : {});
  }
  if (config.WORKER_POOLS.includes('email') && config.WEB_URL) {
    complianceWorker.configureDataExportNotice({ webUrl: config.WEB_URL });
  }
  // S9-03: portal feeds (exports pool) — image URLs under the media CDN, the nightly hour and the pool caps.
  if (config.WORKER_POOLS.includes('exports') && config.MEDIA_CDN_URL) {
    exportsWorker.configurePortalFeeds({ mediaBaseUrl: config.MEDIA_CDN_URL });
    // S9-04: push portals' partner API endpoints (sandbox until H6 completes); a portal without both is not configured.
    exportsWorker.configurePortalPush({
      endpoints: {
        ...(config.IDEALISTA_API_BASE && config.IDEALISTA_TOKEN_URL
          ? { idealista: { apiBase: config.IDEALISTA_API_BASE, tokenUrl: config.IDEALISTA_TOKEN_URL } }
          : {}),
        ...(config.FOTOCASA_API_BASE && config.FOTOCASA_TOKEN_URL
          ? { fotocasa: { apiBase: config.FOTOCASA_API_BASE, tokenUrl: config.FOTOCASA_TOKEN_URL } }
          : {}),
      },
    });
    exportsWorker.configurePortalFeedJobs({
      ...(config.EXPORTS_NIGHTLY_HOUR_UTC !== undefined ? { nightlyHourUtc: config.EXPORTS_NIGHTLY_HOUR_UTC } : {}),
      ...(config.EXPORTS_NIGHTLY_LANES ? { nightlyLanes: config.EXPORTS_NIGHTLY_LANES } : {}),
      ...(config.EXPORTS_PORTAL_FEEDS_MAX_CONCURRENT
        ? { maxConcurrentRuns: config.EXPORTS_PORTAL_FEEDS_MAX_CONCURRENT }
        : {}),
      ...(config.EXPORTS_PORTAL_FEEDS_PER_PROCESS ? { runsPerProcess: config.EXPORTS_PORTAL_FEEDS_PER_PROCESS } : {}),
    });
  }
  // S7-06: the indexing pool purges the website API's edge cache (same tag key as feed-api); without a zone and token
  // there is nothing to purge and cached answers expire with their TTL.
  if (config.HMAC_KEY) websiteApi.configureEdgeCache({ tagKey: config.HMAC_KEY });
  // S8-F1: the network feed sweep's window (the outbox subscriber throttles one sweep per window).
  if (config.SITE_FEED_NETWORK_WINDOW_MINUTES) {
    websiteApi.configureSiteFeedFanout({ networkWindowMs: config.SITE_FEED_NETWORK_WINDOW_MINUTES * 60_000 });
  }
  if (config.CLOUDFLARE_ZONE_ID && config.CLOUDFLARE_PURGE_TOKEN) {
    configureCdn(
      createCloudflarePurger({
        zoneId: config.CLOUDFLARE_ZONE_ID,
        apiToken: config.CLOUDFLARE_PURGE_TOKEN,
        minIntervalMs: config.CDN_PURGE_MIN_INTERVAL_MS,
        logger,
      }),
    );
  }
  if (config.HMAC_KEY && config.WEB_URL)
    identity.configureIdentity({ hmacKey: config.HMAC_KEY, webUrl: config.WEB_URL });
  // S11-01: the client fingerprint rehash (HMAC rotation) decrypts registrations' snapshots and re-fingerprints them.
  if (config.HMAC_KEY && config.ENCRYPTION_KEYS && config.ENCRYPTION_ACTIVE_KEY_ID) {
    mls.configureMls({
      keyring: keyringFromEnv({
        ENCRYPTION_KEYS: config.ENCRYPTION_KEYS,
        ENCRYPTION_ACTIVE_KEY_ID: config.ENCRYPTION_ACTIVE_KEY_ID,
      }),
      fingerprintKey: config.HMAC_KEY,
    });
  }
  // Feed credentials (S6-01): decrypted by `imports.runFeed`. Encryption keys only reach non-media pools (S3-F7).
  if (config.ENCRYPTION_KEYS && config.ENCRYPTION_ACTIVE_KEY_ID) {
    imports.configureImports({
      keyring: keyringFromEnv({
        ENCRYPTION_KEYS: config.ENCRYPTION_KEYS,
        ENCRYPTION_ACTIVE_KEY_ID: config.ENCRYPTION_ACTIVE_KEY_ID,
      }),
      ...(config.IMPORT_WITHDRAW_AFTER_MISSED_RUNS
        ? { withdrawAfterMissedRuns: config.IMPORT_WITHDRAW_AFTER_MISSED_RUNS }
        : {}),
      // S6-08: global cap, anomaly guard and freshness-via-feed settings (validated by `importsEnv`).
      ...(config.IMPORT_MAX_CONCURRENT_RUNS ? { maxConcurrentRuns: config.IMPORT_MAX_CONCURRENT_RUNS } : {}),
      ...(config.IMPORT_RUNS_PER_PROCESS ? { runsPerProcess: config.IMPORT_RUNS_PER_PROCESS } : {}),
      ...(config.IMPORT_ANOMALY_SPIKE_FACTOR ? { anomalySpikeFactor: config.IMPORT_ANOMALY_SPIKE_FACTOR } : {}),
      ...(config.IMPORT_ANOMALY_DROP_RATIO ? { anomalyDropRatio: config.IMPORT_ANOMALY_DROP_RATIO } : {}),
      ...(config.IMPORT_FEED_FRESHNESS_DAYS ? { feedFreshnessDays: config.IMPORT_FEED_FRESHNESS_DAYS } : {}),
    });
  }
  // S7-F3: feed-image jobs at once across the pool and in this process (validated by `importsEnv`).
  media.configureFeedImages({
    ...(config.IMPORT_IMAGE_JOBS_MAX_CONCURRENT ? { maxConcurrentJobs: config.IMPORT_IMAGE_JOBS_MAX_CONCURRENT } : {}),
    ...(config.IMPORT_IMAGE_JOBS_PER_PROCESS ? { jobsPerProcess: config.IMPORT_IMAGE_JOBS_PER_PROCESS } : {}),
  });
  configureStorage(storageConfigFromEnv(config as Parameters<typeof storageConfigFromEnv>[0]));
  if (config.MEDIA_URL_KEY) media.configureMedia({ urlKey: config.MEDIA_URL_KEY });
  if (config.MEILI_URL && config.MEILI_MASTER_KEY) {
    configureSearch(searchConfigFromEnv({ MEILI_URL: config.MEILI_URL, MEILI_MASTER_KEY: config.MEILI_MASTER_KEY }));
    applySearchSettings();
  }
  registerSubscriptions();

  const worker = await startWorker({
    logger,
    pools: config.WORKER_POOLS,
    jobs: POOL_JOBS,
    poolOverrides: POOL_OPTIONS,
    createDispatcher: () => createOutboxDispatcher({ logger }),
    trustProxy: config.TRUST_PROXY,
    checks: { db: () => pingDb(mediaOnly ? 'app_media' : 'app_system'), redisQueue: redisCheck(producerConnection) },
  });

  gracefulShutdown({
    logger,
    steps: [
      { name: 'pools', run: worker.drain },
      { name: 'queue', run: closeQueues },
      { name: 'cache', run: closeCache },
      { name: 'email', run: closeEmail },
      { name: 'db', run: closeDb },
      { name: 'telemetry', run: telemetry.shutdown },
    ],
  });
  await worker.health.listen({ host: config.HOST, port: config.WORKER_HEALTH_PORT });
} catch (err) {
  logger.fatal({ err }, 'worker failed to start');
  reportError(err, { phase: 'startup' });
  await telemetry.shutdown();
  process.exit(1);
}

/**
 * Index settings are applied by code at boot (S5-02), idempotently: an unchanged definition sends nothing. Search
 * down must not stop the worker: it retries in the background until it succeeds.
 */
function applySearchSettings(attempt = 0): void {
  search
    .ensureListingsIndex()
    .then((r) => logger.info({ created: r.created, changed: r.changed }, 'search index settings applied'))
    .catch((err: unknown) => {
      logger.warn({ err, attempt }, 'search index settings not applied; retrying');
      setTimeout(() => applySearchSettings(attempt + 1), Math.min(60_000, 5_000 * 2 ** attempt)).unref();
    });
}
