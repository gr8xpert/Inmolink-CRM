import { createPrivateKey, createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { createKeyring, parseKeyList } from '../crypto/aead';

/**
 * Zod-validated environment. Each app loads only the sections it uses, once at boot:
 *
 *   export const config = loadConfigOrExit({ ...coreEnv, ...databaseEnv, ...redisEnv });
 *
 * Every problem is reported at once and boot stops — nothing reads `process.env` later.
 * Error messages name the variable but never echo its value (it may be a secret).
 */
const url = (protocols: string[]) =>
  z.url().refine((v) => protocols.some((p) => v.startsWith(`${p}://`)), {
    message: `must start with ${protocols.map((p) => `${p}://`).join(' or ')}`,
  });

const nonEmpty = z.string().trim().min(1);

export const coreEnv = {
  NODE_ENV: z.enum(['development', 'test', 'production']),
  /** http | worker | script — `withSystem()` is refused when http (S0-04). */
  APP_ROLE: z.enum(['http', 'worker', 'script']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
};

export const databaseEnv = {
  DATABASE_URL_APP_USER: url(['postgres', 'postgresql']),
  /** BYPASSRLS role — workers and scripts only; refused for APP_ROLE=http in production. */
  DATABASE_URL_APP_SYSTEM: url(['postgres', 'postgresql']).optional(),
  DATABASE_URL_APP_PUBLIC: url(['postgres', 'postgresql']),
  /** Identity tables only (sign-up, login, reset, access tokens) — the auth flows in web (S0-09). */
  DATABASE_URL_APP_AUTH: url(['postgres', 'postgresql']).optional(),
  /** Staff request paths (`withStaff`, S1-03, ADR 0015) — `api` only. */
  DATABASE_URL_APP_STAFF: url(['postgres', 'postgresql']).optional(),
  // The media worker's narrow role (S3-F4): media_objects and property_media only.
  DATABASE_URL_APP_MEDIA: url(['postgres', 'postgresql']).optional(),
};

/** Migrations and ops scripts only — never loaded by app runtimes. */
export const databaseOwnerEnv = {
  DATABASE_URL_APP_OWNER: url(['postgres', 'postgresql']),
};

/** Bootstrap superuser for role setup in `pnpm db:migrate`; optional where ops provisions roles. */
export const databaseAdminEnv = {
  DATABASE_URL_ADMIN: url(['postgres', 'postgresql']).optional(),
};

export const redisEnv = {
  REDIS_QUEUE_URL: url(['redis', 'rediss']),
  REDIS_CACHE_URL: url(['redis', 'rediss']),
};

/**
 * Rate-limit counters (S1-F6): a Redis that never evicts, so memory pressure cannot reset a login limit.
 * redis-queue in every environment; production connects as an ACL user limited to `inl:rl:*` keys.
 */
export const rateLimitEnv = {
  REDIS_LIMITS_URL: url(['redis', 'rediss']),
};

/** A listen port with a per-app default; each app names its own variable (`API_PORT`, `FEED_API_PORT`, …). */
export const portVar = (fallback: number) => z.coerce.number().int().min(0).max(65_535).default(fallback);

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
/** Narrowest ranges that still describe "our proxies"; wider ones are as good as trusting everyone. */
const MIN_PREFIX = { 4: 8, 6: 16 } as const;
const MAX_PROXY_HOPS = 3;

/** A proxy-addr entry that names specific proxies: a keyword, an IP, or a CIDR no wider than /8 (v4) or /16 (v6). */
function isProxyItem(item: string): boolean {
  if (PROXY_KEYWORDS.has(item)) return true;
  const [address = '', prefix, ...rest] = item.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= MIN_PREFIX[family as 4 | 6] && bits <= (family === 4 ? 32 : 128);
}

/** HTTP apps (api, feed-api, realtime, worker health server). */
export const httpEnv = {
  /** `0.0.0.0` in containers; loopback by default so a dev box never exposes an app. */
  HOST: nonEmpty.default('127.0.0.1'),
  /**
   * Proxies in front of the app, for `request.ip`: a hop count (1–3; `1` = kamal-proxy) or a comma list
   * of IPs / CIDRs (/8 or narrower for IPv4, /16 for IPv6) / `loopback`. `false` (default) trusts nobody.
   * `true`, catch-all ranges and large hop counts are refused — each would let a client forge
   * `X-Forwarded-For` and get a fresh rate-limit bucket per request.
   */
  TRUST_PROXY: z
    .string()
    .trim()
    .default('false')
    .transform((value, ctx): false | number | string[] => {
      if (value === 'false' || value === '0') return false;
      if (/^\d+$/.test(value)) {
        const hops = Number(value);
        if (hops <= MAX_PROXY_HOPS) return hops;
        ctx.addIssue({ code: 'custom', message: `hop count must be at most ${MAX_PROXY_HOPS}` });
        return z.NEVER;
      }
      const list = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0 || !list.every(isProxyItem)) {
        ctx.addIssue({
          code: 'custom',
          message: 'must be false, a hop count or a comma list of proxy IPs/CIDRs (no catch-all ranges) — never true',
        });
        return z.NEVER;
      }
      return list;
    }),
  /** Milliseconds to keep serving (with `/readyz` failing) before closing, so a load balancer can route away. */
  SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().min(0).max(20_000).default(0),
  /**
   * Header the edge (CDN / kamal-proxy) sets with its request id, e.g. `cf-ray`. Only this header is
   * trusted for correlation; a client-sent `x-request-id` is logged as `clientRequestId` instead.
   */
  EDGE_REQUEST_ID_HEADER: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{1,64}$/, 'must be a header name')
    .optional(),
};

export const searchEnv = {
  MEILI_URL: url(['http', 'https']),
  /** Admin key — worker indexing and scripts only; refused for APP_ROLE=http in production (S1-F5). */
  MEILI_MASTER_KEY: nonEmpty,
  /**
   * Search-only key (`actions: ["search"]`) for request-path apps (api, feed-api). Optional until the
   * search adapter reads it; created once per deployment (docs/runbooks/deploy.md).
   */
  MEILI_SEARCH_KEY: nonEmpty.optional(),
};

/**
 * Website search (S5-04, S6-F3, PLAN §5.4): how long a request waits for the engine and when it stops trusting it.
 * The engine call is cut at `SEARCH_ENGINE_TIMEOUT_MS`; at `SEARCH_SLOW_MS` the Postgres fallback starts beside it and
 * the first answer wins (an answer slower than that also counts against the engine). The breaker opens on
 * `SEARCH_BREAKER_FAILURES` failed or slow calls in a row, or on a failed-or-slow share of at least
 * `SEARCH_BREAKER_FAILURE_RATIO` among ≥ `SEARCH_BREAKER_MIN_CALLS` calls within `SEARCH_BREAKER_WINDOW_MS`, and stays
 * open `SEARCH_BREAKER_OPEN_MS`. At most `SEARCH_HEDGE_MAX_IN_FLIGHT` fallback statements run beside the engine at once
 * per process; past that a request waits for the engine up to its timeout. The slow threshold must be below the timeout (checked at boot by the search module).
 */
export const websiteSearchEnv = {
  SEARCH_ENGINE_TIMEOUT_MS: z.coerce.number().int().min(20).max(5_000).default(100),
  SEARCH_SLOW_MS: z.coerce.number().int().min(10).max(5_000).default(80),
  SEARCH_BREAKER_FAILURES: z.coerce.number().int().min(1).max(1_000).default(5),
  SEARCH_BREAKER_FAILURE_RATIO: z.coerce.number().gt(0).max(1).default(0.5),
  SEARCH_BREAKER_MIN_CALLS: z.coerce.number().int().min(1).max(100_000).default(20),
  SEARCH_BREAKER_WINDOW_MS: z.coerce.number().int().min(1_000).max(600_000).default(10_000),
  SEARCH_BREAKER_OPEN_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  /** Fallback statements started beside a slow engine at once, per process (the losing one is not cancelled). */
  SEARCH_HEDGE_MAX_IN_FLIGHT: z.coerce.number().int().min(0).max(1_000).default(16),
  /**
   * Free text matches other agencies' (network) documents on websites (S7-F5). Set `false` from a deploy with S7-F5
   * until the white-labelled reindex has finished (runbook `search.md`): free text then matches own documents only.
   */
  SEARCH_NETWORK_FREE_TEXT: z.enum(['true', 'false']).default('true'),
};

/**
 * Feed imports (S6-02): successful runs in a row a listing may be missing from its feed before the run withdraws it
 * (a connection's `withdrawAfterMissedRuns` setting overrides it).
 *
 * S6-08: `IMPORT_MAX_CONCURRENT_RUNS` — feed runs running at once across every worker of the `imports` pool (the
 * other jobs of the pool keep their slots). `IMPORT_RUNS_PER_PROCESS` (S6 review): feed runs one worker process runs at
 * once — a 100 MB run adds about 110–150 MB, so this bounds a process's RSS; runs at once across the pool are the
 * smaller of the two caps and processes × this one. Anomaly guard: a run with more than `IMPORT_ANOMALY_SPIKE_FACTOR` × the
 * feed's typical item count, or one where more than `IMPORT_ANOMALY_DROP_RATIO` of the feed's listings vanish at once,
 * pauses the connection instead of writing on / withdrawing. `IMPORT_FEED_FRESHNESS_DAYS`: a successful run confirms
 * its listings as still on the market (S3-08) only while some item of the feed was added, removed or changed within
 * that many days.
 */
export const importsEnv = {
  IMPORT_WITHDRAW_AFTER_MISSED_RUNS: z.coerce.number().int().min(1).max(100).default(3),
  IMPORT_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(1_000).default(24),
  IMPORT_RUNS_PER_PROCESS: z.coerce.number().int().min(1).max(10).default(2),
  IMPORT_ANOMALY_SPIKE_FACTOR: z.coerce.number().min(1.5).max(100).default(5),
  IMPORT_ANOMALY_DROP_RATIO: z.coerce.number().gt(0).max(1).default(0.3),
  IMPORT_FEED_FRESHNESS_DAYS: z.coerce.number().int().min(1).max(3_650).default(120),
};

/**
 * Network search give-to-get (PLAN §3 #5, S5-05): ACTIVE listings an agency must share with the network to search
 * it, and the grace period of a new agency (days from sign-up).
 */
export const networkEnv = {
  NETWORK_GIVE_TO_GET_MIN_SHARED: z.coerce.number().int().min(0).max(1_000).default(5),
  NETWORK_GIVE_TO_GET_GRACE_DAYS: z.coerce.number().int().min(0).max(365).default(30),
};

/**
 * Cloudflare Turnstile (S1-F5): the challenge shown once a per-email login ceiling is reached. Both or
 * neither; unset, the ceiling stays a hard block. Cloudflare's test keys are refused in production.
 */
export const turnstileEnv = {
  TURNSTILE_SITE_KEY: nonEmpty.optional(),
  TURNSTILE_SECRET_KEY: nonEmpty.optional(),
};

export const storageEnv = {
  S3_ENDPOINT: url(['http', 'https']),
  S3_REGION: nonEmpty,
  S3_ACCESS_KEY_ID: nonEmpty,
  S3_SECRET_ACCESS_KEY: nonEmpty,
  S3_BUCKET_MEDIA: nonEmpty,
  S3_BUCKET_EXPORTS: nonEmpty,
  /** Private documents (agency verification): no public access, read only through short signed URLs (S1-03). */
  S3_BUCKET_PRIVATE: nonEmpty,
  /** Media originals and masters (S3-F9): no public access; the media container's token covers it, not the private bucket. */
  S3_BUCKET_MEDIA_WORK: nonEmpty,
};

/** Transactional email (platform/email). Workers only: requests never send mail. */
export const emailEnv = {
  /** `smtp` (Mailpit locally, or Amazon SES SMTP) | `resend`. */
  EMAIL_DRIVER: z.enum(['smtp', 'resend']).default('smtp'),
  /** `Name <address>` or a bare address. */
  EMAIL_FROM: nonEmpty.refine((v) => !/[\r\n]/.test(v), 'must be one line'),
  SMTP_URL: url(['smtp', 'smtps']).optional(),
  RESEND_API_KEY: nonEmpty.optional(),
};

/** Base URL of the dashboard (`web`) — email links, CORS and socket origin allowlists. */
export const webUrlEnv = {
  WEB_URL: url(['http', 'https']).transform((v) => v.replace(/\/+$/, '')),
};

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Mints access tokens — `web` only (platform/jwt). */
export const authSignEnv = {
  /** base64(PKCS#8 DER) of an Ed25519 key. */
  AUTH_JWT_PRIVATE_KEY: nonEmpty,
  AUTH_JWT_KEY_ID: z.string().regex(KEY_ID, 'must be 1–32 of A-Z a-z 0-9 _ -'),
};

/** Verifies access tokens — `api`, `realtime` (platform/jwt). */
export const authVerifyEnv = {
  /** `kid:base64(SPKI DER)[,kid:base64…]`; keep the previous key listed for 15 minutes after a rotation. */
  AUTH_JWT_PUBLIC_KEYS: nonEmpty,
};

/** Encrypts the Auth.js session cookie — `web` only. 32+ random bytes; "dev-…" values are refused in production. */
export const authSessionEnv = {
  AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
};

/**
 * Public halves of the access-token keys committed in `.env.example` / `.env.test.example`. Refused in
 * production whatever key id they are listed under (a renamed example key is still public).
 */
const EXAMPLE_JWT_PUBLIC_KEYS = new Set([
  'MCowBQYDK2VwAyEA57hG/H5HUDaL1k17CeMBqE03zTvNPgLVHoX7DKSYyqs=',
  'MCowBQYDK2VwAyEAAy6KQhRaNdNDpYjKEVK5HhvejcYzS9e8Etz1obQc7II=',
]);

/**
 * Secret material committed in `.env.example` / `.env.test.example` (public by definition). Production
 * refuses a value that contains one, whatever prefix or key id it carries — dropping `dev-` is not a
 * new secret (S1-F5). Encryption keys are compared as bytes.
 */
const EXAMPLE_SECRETS = [
  'P7U9zqzYvnRL38PwBgXH3LqIdqLN3IDtvyLOnitUOJE',
  'xOmUta9NX3C5Z_oJq3EJuq5OargPUZY27uzbpxkbv5s',
  '01c1d8e276ba8bfe3a373a947be2a96c5706827172d0449d9dac51abbe9b621b',
  '7e010e159bffe2c51832864979e6b72652776ca7ea39d1fd9b81bcfaa227b7f8',
  '5b0e2f7c91d34a6e8f1c0b9d2a7e4f6153c8d9e0a1b2c3d4e5f60718293a4b5c',
  'c4a91e0f6b2d47388e5f1a9c0d3b7e2f4a6c8e0b1d3f5a7c9e1b3d5f7a9c0e2f',
];
const EXAMPLE_ENCRYPTION_KEYS = new Set([
  'gOid8c3Gq/xDngwo9zS6C1RbtlAac+1xxS+dcK8Kfak=',
  '9A7vGB1PcY5bAilbX41zlnFBSMSlUhnJE2C/ML9bp9s=',
]);
const isExampleSecret = (value: string) => EXAMPLE_SECRETS.some((s) => value.includes(s));
/** Cloudflare's published Turnstile test keys (`1x0000…AA`, `2x0000…AB`, …): always pass or always fail. */
const TURNSTILE_TEST_KEY = /^[0-9]x0{10,}[A-Z]{2}$/;

/** Traces, metrics and error reporting (S0-10, platform/telemetry). Each app adds its own `METRICS_PORT`. */
export const telemetryEnv = {
  /** OTLP/HTTP base URL (the collector, `/v1/traces` is appended). Unset: spans are not exported. */
  OTEL_EXPORTER_OTLP_ENDPOINT: url(['http', 'https']).optional(),
  /** Share of new traces kept (parent-based: a sampled caller's trace is always continued). */
  OTEL_TRACES_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),
  /**
   * Prometheus `/metrics` bind address — private: never the public interface (the endpoint has no auth).
   * Production accepts loopback or a private address; `0.0.0.0`/`::` only with METRICS_ALLOW_WILDCARD=true
   * (a container whose metrics port is not published and is fenced by network policy).
   */
  METRICS_HOST: nonEmpty.default('127.0.0.1'),
  METRICS_ALLOW_WILDCARD: z.enum(['true', 'false']).default('false'),
  /** Unset: errors are only logged. */
  SENTRY_DSN: url(['https', 'http']).optional(),
  /** Deploy name for Sentry/OTel (`production`, `staging`, …); defaults to NODE_ENV. */
  DEPLOY_ENV: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .optional(),
  /** Build identifier (git SHA) — tags errors and spans. */
  RELEASE: z
    .string()
    .regex(/^[A-Za-z0-9._@+-]{1,64}$/)
    .default('dev'),
};

export const cryptoEnv = {
  /** `keyId:base64Key[,keyId:base64Key…]` — 32-byte AES keys; see platform/crypto. */
  ENCRYPTION_KEYS: nonEmpty,
  ENCRYPTION_ACTIVE_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'must be a key id from ENCRYPTION_KEYS'),
  /** Dedicated HMAC key (fingerprints, idempotency keys); at least 32 chars. */
  HMAC_KEY: z.string().min(32, 'must be at least 32 characters'),
};

/**
 * Media variant URLs (S3-04): the key their public ids are derived with. Its own key, kept for good: rotating
 * it moves every variant URL (bump the media pipeline version with it). At least 32 chars.
 */
export const mediaEnv = {
  MEDIA_URL_KEY: z.string().min(32, 'must be at least 32 characters'),
};

export type EnvShape = Record<string, z.ZodType>;
export type Config<S extends EnvShape> = z.infer<z.ZodObject<S>>;
type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(public readonly problems: { key: string; message: string }[]) {
    super(
      `Invalid environment configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p.key}: ${p.message}`).join('\n') +
        '\nSet these variables (see .env.example) and restart.',
    );
  }
}

/** Validates `env` against the given sections. Throws `ConfigError` listing every problem. */
export function loadConfig<S extends EnvShape>(shape: S, env: Env = process.env): Readonly<Config<S>> {
  // Empty strings count as unset, so `FOO=` in a .env file is reported as missing.
  const input: Env = {};
  for (const key of Object.keys(shape)) {
    const value = env[key];
    input[key] = value === '' ? undefined : value;
  }

  const result = z.object(shape).safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const key = String(issue.path[0] ?? '(root)');
        const missing = issue.code === 'invalid_type' && input[key] === undefined;
        return { key, message: missing ? 'is required but not set' : issue.message };
      }),
    );
  }
  const problems = crossChecks(result.data as Record<string, unknown>, env);
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(result.data);
}

/** Checks that span several variables or need parsing beyond one field. */
function crossChecks(cfg: Record<string, unknown>, env: Env): { key: string; message: string }[] {
  const problems: { key: string; message: string }[] = [];
  const production = (cfg.NODE_ENV ?? env.NODE_ENV) === 'production';

  if (typeof cfg.ENCRYPTION_KEYS === 'string' && typeof cfg.ENCRYPTION_ACTIVE_KEY_ID === 'string') {
    try {
      const keys = parseKeyList(cfg.ENCRYPTION_KEYS);
      createKeyring({ keys, activeKeyId: cfg.ENCRYPTION_ACTIVE_KEY_ID });
      if (production && Object.keys(keys).some((id) => id.startsWith('dev'))) {
        problems.push({ key: 'ENCRYPTION_KEYS', message: 'dev keys (id "dev…") are not allowed in production' });
      } else if (production && Object.values(keys).some((k) => EXAMPLE_ENCRYPTION_KEYS.has(normalizeBase64(k)))) {
        problems.push({ key: 'ENCRYPTION_KEYS', message: 'is a committed example key; generate a new one' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'is invalid';
      const key = /Active encryption key/.test(message) ? 'ENCRYPTION_ACTIVE_KEY_ID' : 'ENCRYPTION_KEYS';
      problems.push({ key, message });
    }
  }
  if (production && cfg.APP_ROLE === 'http' && cfg.DATABASE_URL_APP_SYSTEM !== undefined) {
    problems.push({
      key: 'DATABASE_URL_APP_SYSTEM',
      message: 'must not be set for APP_ROLE=http in production (BYPASSRLS credential; workers and scripts only)',
    });
  }
  // Sampling every trace at feed-api's request rate would drop spans and cost CPU: choose it per deploy.
  if (production && 'OTEL_TRACES_SAMPLE_RATIO' in cfg && (env.OTEL_TRACES_SAMPLE_RATIO ?? '').trim() === '') {
    problems.push({ key: 'OTEL_TRACES_SAMPLE_RATIO', message: 'must be set explicitly in production (e.g. 0.05)' });
  }
  if (production && typeof cfg.METRICS_HOST === 'string' && !metricsHostAllowed(cfg.METRICS_HOST, cfg)) {
    problems.push({
      key: 'METRICS_HOST',
      message: 'must be loopback or a private address in production (wildcard needs METRICS_ALLOW_WILDCARD=true)',
    });
  }
  if (production && typeof cfg.SENTRY_DSN === 'string' && !cfg.SENTRY_DSN.startsWith('https://')) {
    problems.push({ key: 'SENTRY_DSN', message: 'must use https in production' });
  }
  if (production && cfg.RELEASE === 'dev') {
    problems.push({ key: 'RELEASE', message: 'must be the build id (git SHA) in production' });
  }
  if (production && typeof cfg.HMAC_KEY === 'string' && cfg.HMAC_KEY.startsWith('dev-')) {
    problems.push({ key: 'HMAC_KEY', message: 'dev keys ("dev-…") are not allowed in production' });
  } else if (production && typeof cfg.HMAC_KEY === 'string' && isExampleSecret(cfg.HMAC_KEY)) {
    problems.push({ key: 'HMAC_KEY', message: 'is a committed example value; generate a new one' });
  }
  if (production && typeof cfg.MEDIA_URL_KEY === 'string' && cfg.MEDIA_URL_KEY.startsWith('dev-')) {
    problems.push({ key: 'MEDIA_URL_KEY', message: 'dev keys ("dev-…") are not allowed in production' });
  } else if (production && typeof cfg.MEDIA_URL_KEY === 'string' && isExampleSecret(cfg.MEDIA_URL_KEY)) {
    problems.push({ key: 'MEDIA_URL_KEY', message: 'is a committed example value; generate a new one' });
  }
  // Read from the raw env: request apps do not declare the variable, so it would never reach `cfg`.
  if (production && cfg.APP_ROLE === 'http' && (env.MEILI_MASTER_KEY ?? '').trim() !== '') {
    problems.push({
      key: 'MEILI_MASTER_KEY',
      message: 'must not be set for APP_ROLE=http in production (admin key; use MEILI_SEARCH_KEY)',
    });
  }
  if ((cfg.TURNSTILE_SITE_KEY === undefined) !== (cfg.TURNSTILE_SECRET_KEY === undefined)) {
    const key = cfg.TURNSTILE_SITE_KEY === undefined ? 'TURNSTILE_SITE_KEY' : 'TURNSTILE_SECRET_KEY';
    problems.push({ key, message: 'TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set together or not at all' });
  }
  for (const key of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'] as const) {
    const value = cfg[key];
    if (production && typeof value === 'string' && TURNSTILE_TEST_KEY.test(value)) {
      problems.push({ key, message: 'Cloudflare test keys are not allowed in production' });
    }
  }
  if (cfg.EMAIL_DRIVER === 'smtp' && cfg.SMTP_URL === undefined) {
    problems.push({ key: 'SMTP_URL', message: 'is required when EMAIL_DRIVER=smtp' });
  }
  if (cfg.EMAIL_DRIVER === 'resend' && cfg.RESEND_API_KEY === undefined) {
    problems.push({ key: 'RESEND_API_KEY', message: 'is required when EMAIL_DRIVER=resend' });
  }
  if (typeof cfg.AUTH_JWT_PRIVATE_KEY === 'string') {
    if (!isEd25519(cfg.AUTH_JWT_PRIVATE_KEY, 'private')) {
      problems.push({ key: 'AUTH_JWT_PRIVATE_KEY', message: 'must be base64 PKCS#8 DER of an Ed25519 key' });
    }
    if (production && typeof cfg.AUTH_JWT_KEY_ID === 'string' && cfg.AUTH_JWT_KEY_ID.startsWith('dev')) {
      problems.push({ key: 'AUTH_JWT_KEY_ID', message: 'dev keys (id "dev…") are not allowed in production' });
    }
    if (production && EXAMPLE_JWT_PUBLIC_KEYS.has(publicOf(cfg.AUTH_JWT_PRIVATE_KEY) ?? '')) {
      problems.push({ key: 'AUTH_JWT_PRIVATE_KEY', message: 'is a committed example key; generate a new one' });
    }
  }
  if (production && typeof cfg.AUTH_SECRET === 'string' && cfg.AUTH_SECRET.startsWith('dev-')) {
    problems.push({ key: 'AUTH_SECRET', message: 'dev values ("dev-…") are not allowed in production' });
  } else if (production && typeof cfg.AUTH_SECRET === 'string' && isExampleSecret(cfg.AUTH_SECRET)) {
    problems.push({ key: 'AUTH_SECRET', message: 'is a committed example value; generate a new one' });
  }
  if (typeof cfg.AUTH_JWT_PUBLIC_KEYS === 'string') {
    const entries = cfg.AUTH_JWT_PUBLIC_KEYS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((e) => [e.slice(0, Math.max(0, e.indexOf(':'))), e.slice(e.indexOf(':') + 1)] as const);
    if (entries.length === 0 || entries.some(([kid, key]) => !KEY_ID.test(kid) || !isEd25519(key, 'public'))) {
      problems.push({
        key: 'AUTH_JWT_PUBLIC_KEYS',
        message: 'must be kid:base64(SPKI DER) Ed25519 keys, comma-separated',
      });
    } else if (
      production &&
      entries.some(([kid, key]) => kid.startsWith('dev') || EXAMPLE_JWT_PUBLIC_KEYS.has(normalizeBase64(key)))
    ) {
      problems.push({
        key: 'AUTH_JWT_PUBLIC_KEYS',
        message: 'dev or committed example keys are not allowed in production',
      });
    }
  }
  return problems;
}

/** SPKI base64 of the private key's public half, for the example-key check. */
const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./];

function metricsHostAllowed(host: string, cfg: Record<string, unknown>): boolean {
  if (host === '0.0.0.0' || host === '::') return cfg.METRICS_ALLOW_WILDCARD === 'true';
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) return PRIVATE_V4.some((r) => r.test(host));
  if (isIP(host) === 6) return /^f[cd][0-9a-f]{2}:/i.test(host);
  return false; // hostnames may resolve anywhere
}

function publicOf(privateB64: string): string | undefined {
  try {
    const key = createPrivateKey({ key: Buffer.from(privateB64, 'base64'), format: 'der', type: 'pkcs8' });
    return createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
  } catch {
    return undefined;
  }
}

function normalizeBase64(b64: string): string {
  return Buffer.from(b64, 'base64').toString('base64');
}

function isEd25519(b64: string, kind: 'private' | 'public'): boolean {
  try {
    const der = Buffer.from(b64, 'base64');
    const key =
      kind === 'private'
        ? createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
        : createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export interface ExitIo {
  exit: (code: number) => never;
  error: (message: string) => void;
}

const processIo: ExitIo = {
  exit: (code) => process.exit(code),
  error: (message) => process.stderr.write(`${message}\n`),
};

/** For app entry points: prints the problems and exits with code 1. */
export function loadConfigOrExit<S extends EnvShape>(
  shape: S,
  env: Env = process.env,
  io: ExitIo = processIo,
): Readonly<Config<S>> {
  try {
    return loadConfig(shape, env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.error(err.message);
    return io.exit(1);
  }
}
