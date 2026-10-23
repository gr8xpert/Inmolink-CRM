import {
  type Config,
  cdnPurgeEnv,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  emailEnv,
  httpEnv,
  importsEnv,
  loadConfigOrExit,
  mediaCdnEnv,
  mediaEnv,
  portalFeedsEnv,
  portalPushEnv,
  portVar,
  redisEnv,
  searchEnv,
  siteFeedNetworkEnv,
  storageEnv,
  telemetryEnv,
  webUrlEnv,
} from '@inmolink/platform/config';
import type { EmailConfig } from '@inmolink/platform/email';
import { z } from 'zod';

/** Worker pools (workers.md); each can run on its own node via `WORKER_POOLS`. */
export const POOLS = [
  'outbox',
  'imports',
  'media',
  'indexing',
  'matching',
  'exports',
  'email',
  'ai',
  'social',
  'pdf',
  'maintenance',
] as const;
export type Pool = (typeof POOLS)[number];

const poolsVar = z
  .string()
  .trim()
  .default('all')
  .transform((value, ctx): Pool[] => {
    if (value === 'all') return [...POOLS];
    const names = [...new Set(value.split(',').map((s) => s.trim()))].filter(Boolean);
    const unknown = names.filter((n) => !(POOLS as readonly string[]).includes(n));
    if (names.length === 0 || unknown.length > 0) {
      ctx.addIssue({ code: 'custom', message: `must be "all" or a comma list of ${POOLS.join(', ')}` });
      return z.NEVER;
    }
    return names as Pool[];
  });

/** What every worker process needs, whatever it runs. */
const baseEnv = {
  ...coreEnv,
  ...httpEnv,
  /** Comma list of pools this process runs, or `all`. */
  WORKER_POOLS: poolsVar,
  /** Health server for the orchestrator (`/healthz`, `/readyz`); bind it to a private interface. */
  WORKER_HEALTH_PORT: portVar(4003),
  /** Prometheus `/metrics` on `METRICS_HOST` (private); 0 turns it off. */
  WORKER_METRICS_PORT: portVar(9467),
  ...telemetryEnv,
  REDIS_QUEUE_URL: redisEnv.REDIS_QUEUE_URL,
};

/** Every pool but `media`: the outbox and cross-tenant jobs run `withSystem`; tokens, links and stored credentials. */
const systemEnv = {
  DATABASE_URL_APP_USER: databaseEnv.DATABASE_URL_APP_USER,
  // Required here (optional in platform): the outbox and cross-tenant jobs run `withSystem`.
  DATABASE_URL_APP_SYSTEM: databaseEnv.DATABASE_URL_APP_SYSTEM.unwrap(),
  // Never for media alone (S3-F7): a decoder exploit must not reach the bodies the api serves from the cache.
  REDIS_CACHE_URL: redisEnv.REDIS_CACHE_URL,
  ...cryptoEnv,
  // Exports and the orphan sweeps (S1-F7) read and write object storage.
  ...storageEnv,
  ...webUrlEnv,
  // Feed runs (S6-02): when a listing missing from its feed is withdrawn.
  ...importsEnv,
  // S8-F1: how often network sites' XML feeds are swept after listings left the network.
  ...siteFeedNetworkEnv,
};

/**
 * The `indexing` pool (S5-02): the search engine's admin key applies index settings and writes documents. S7-06: it
 * also purges the website API's edge cache when public listings change (Cloudflare zone and purge-only token).
 */
const indexingEnv = {
  MEILI_URL: searchEnv.MEILI_URL,
  MEILI_MASTER_KEY: searchEnv.MEILI_MASTER_KEY,
  ...cdnPurgeEnv,
};

/**
 * The `email` pool's website lead acknowledgements (S7-05): similar listings come through the website search path as
 * `app_public` (the site's public inventory, never more), with image URLs under the media CDN. Without a search engine
 * key the search answers from its Postgres fallback.
 */
const leadEmailEnv = {
  DATABASE_URL_APP_PUBLIC: databaseEnv.DATABASE_URL_APP_PUBLIC,
  ...mediaCdnEnv,
};

/**
 * The `exports` pool's per-site XML feeds (S7-07): the site's inventory through the website API's read path as
 * `app_public`, image URLs under the media CDN (the same variables as the lead acknowledgements). S9-03: portal feeds'
 * nightly hour and pool caps.
 */
const siteFeedEnv = { ...leadEmailEnv, ...portalFeedsEnv, ...portalPushEnv };

/**
 * The `media` pool (S3-04) decodes untrusted uploads in its own container (S3-F4): object storage, its URL key and
 * the narrow `app_media` role — no `app_system`, no SMTP, no encryption keys, no cache (S3-F7).
 */
const mediaPoolEnv = {
  DATABASE_URL_APP_MEDIA: databaseEnv.DATABASE_URL_APP_MEDIA.unwrap(),
  ...storageEnv,
  ...mediaEnv,
};

/**
 * The env a process running `pools` validates (S3-F4: least privilege per container). SMTP only with `email`;
 * `app_system`, encryption keys and the HMAC key only with a pool other than `media`.
 */
export function workerEnvFor(pools: readonly Pool[]) {
  const others = pools.some((p) => p !== 'media');
  return {
    ...baseEnv,
    ...(others ? systemEnv : {}),
    ...(pools.includes('media') ? mediaPoolEnv : {}),
    ...(pools.includes('email') ? { ...emailEnv, ...leadEmailEnv } : {}),
    ...(pools.includes('exports') ? siteFeedEnv : {}),
    ...(pools.includes('indexing') ? indexingEnv : {}),
  };
}

/** Every variable any pool reads (the deploy-config check lists them). */
export const workerEnv = {
  ...baseEnv,
  ...systemEnv,
  ...mediaPoolEnv,
  ...emailEnv,
  ...leadEmailEnv,
  ...siteFeedEnv,
  ...indexingEnv,
};
type Full = Config<typeof workerEnv>;
/** Pool-dependent variables are absent when no pool of this process needs them (`workerEnvFor`). */
export type WorkerConfig = Config<typeof baseEnv> & Partial<Omit<Full, keyof Config<typeof baseEnv>>>;

/** platform/email driver settings from the validated env (cross-checks guarantee the credential). */
export function emailConfig(config: WorkerConfig): EmailConfig {
  const from = config.EMAIL_FROM as string;
  return config.EMAIL_DRIVER === 'resend'
    ? { driver: 'resend', from, resendApiKey: config.RESEND_API_KEY as string }
    : { driver: 'smtp', from, smtpUrl: config.SMTP_URL as string };
}

/** Reads `WORKER_POOLS` first, then validates only what those pools need (`workerEnvFor`). */
export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const parsed = poolsVar.safeParse(env.WORKER_POOLS);
  const schema = workerEnvFor(parsed.success ? parsed.data : [...POOLS]);
  return loadConfigOrExit(schema, { ...env, APP_ROLE: 'worker' }) as WorkerConfig;
}
