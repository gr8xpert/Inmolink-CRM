import { configureDb, loadStackEnv } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { configureCache } from '@inmolink/platform/cache';
import {
  authSessionEnv,
  authSignEnv,
  type Config,
  ConfigError,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  httpEnv,
  loadConfig,
  rateLimitEnv,
  redisEnv,
  turnstileEnv,
  webUrlEnv,
} from '@inmolink/platform/config';
import { keyringFromEnv } from '@inmolink/platform/crypto';
import { createAccessTokenSigner, privateKeyFromBase64 } from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { configureRateLimit } from '@inmolink/platform/rate-limit';
import { z } from 'zod';

/**
 * Server-side setup for the dashboard (S0-09): Auth.js session secret, `app_auth` pool for the auth
 * flows, redis-cache, redis-queue for login rate limits (S1-F6), the access-token signer and the keyring for TOTP secrets. Loaded once, lazily, on the
 * first request that needs it — never at build time.
 */
export const webEnv = {
  ...coreEnv,
  TRUST_PROXY: httpEnv.TRUST_PROXY,
  /** Correlates auth-flow logs with the edge's request id (S1-F4), like the API. */
  EDGE_REQUEST_ID_HEADER: httpEnv.EDGE_REQUEST_ID_HEADER,
  DATABASE_URL_APP_AUTH: databaseEnv.DATABASE_URL_APP_AUTH.unwrap(),
  REDIS_CACHE_URL: redisEnv.REDIS_CACHE_URL,
  ...rateLimitEnv,
  HMAC_KEY: cryptoEnv.HMAC_KEY,
  /** TOTP secrets are stored encrypted (S1-04). */
  ENCRYPTION_KEYS: cryptoEnv.ENCRYPTION_KEYS,
  ENCRYPTION_ACTIVE_KEY_ID: cryptoEnv.ENCRYPTION_ACTIVE_KEY_ID,
  ...authSignEnv,
  ...webUrlEnv,
  /** Dashboard API base URL for server-side calls. */
  API_URL: z.url().transform((v) => v.replace(/\/+$/, '')),
  /** MapLibre style for the staff taxonomy editor's polygon map (S2-04). The default is MapLibre's demo style; set a real one in production. */
  MAP_STYLE_URL: z.url().default('https://demotiles.maplibre.org/style.json'),
  ...authSessionEnv,
  /** Login challenge once the per-email ceiling is reached (S1-F5); unset keeps the hard block. */
  ...turnstileEnv,
};
export type WebConfig = Config<typeof webEnv>;

let ready: Promise<WebConfig> | undefined;

/**
 * Reads and checks the env without connecting anything. `instrumentation.node.ts` calls it at boot,
 * so a missing variable stops the container instead of failing every login after a green deploy.
 */
export function loadWebConfig(): WebConfig {
  loadStackEnv('dev', { allowExample: false });
  // The web server is a request path: `withSystem` stays refused (APP_ROLE=http).
  const config = loadConfig(webEnv, { ...process.env, APP_ROLE: 'http' });
  if (config.NODE_ENV === 'production' && config.TRUST_PROXY === false) {
    // Next has no socket address: without a trusted proxy hop, X-Forwarded-For is client-controlled.
    throw new ConfigError([{ key: 'TRUST_PROXY', message: 'must name the proxy in front of web in production' }]);
  }
  return config;
}

async function setup(): Promise<WebConfig> {
  const config = loadWebConfig();
  const logger = createLogger({ service: 'web', level: config.LOG_LEVEL });
  await configureDb({ APP_ROLE: 'http', DATABASE_URL_APP_AUTH: config.DATABASE_URL_APP_AUTH }, { logger });
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  await configureRateLimit({ url: config.REDIS_LIMITS_URL, logger });
  identity.configureIdentity({
    hmacKey: config.HMAC_KEY,
    signer: createAccessTokenSigner({
      privateKey: privateKeyFromBase64(config.AUTH_JWT_PRIVATE_KEY),
      keyId: config.AUTH_JWT_KEY_ID,
    }),
    keyring: keyringFromEnv(config),
  });
  return config;
}

export function webConfig(): Promise<WebConfig> {
  ready ??= setup().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}
