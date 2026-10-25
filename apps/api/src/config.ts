import {
  authVerifyEnv,
  type Config,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  httpEnv,
  loadConfigOrExit,
  mediaEnv,
  networkEnv,
  portVar,
  rateLimitEnv,
  redisEnv,
  searchEnv,
  socialEnv,
  storageEnv,
  telemetryEnv,
  websitesEnv,
} from '@inmolink/platform/config';
import { z } from 'zod';

/**
 * Dashboard API: `app_user` (RLS) for tenant routes, `app_staff` (RLS, staff predicates) for staff
 * routes (S1-03), `app_auth` for staff login checks (S1-F7, S1-F9), both Redis instances (rate limits on
 * redis-queue, S1-F6), search (network search, S5-05), object storage (verification documents, media uploads and preview URLs).
 */
export const apiEnv = {
  ...coreEnv,
  ...httpEnv,
  API_PORT: portVar(4000),
  /** Prometheus `/metrics` on `METRICS_HOST` (private); 0 turns it off. */
  API_METRICS_PORT: portVar(9464),
  ...telemetryEnv,
  DATABASE_URL_APP_USER: databaseEnv.DATABASE_URL_APP_USER,
  DATABASE_URL_APP_STAFF: databaseEnv.DATABASE_URL_APP_STAFF.unwrap(),
  /**
   * `app_auth` for the per-request login checks `app_staff` cannot make (it cannot read `users`): a staff
   * caller's account is ACTIVE (S1-F7), and an impersonating staff login is ACTIVE with the token's
   * session version (S1-F9). Short reads of the caller's own `users` row only.
   */
  DATABASE_URL_APP_AUTH: databaseEnv.DATABASE_URL_APP_AUTH.unwrap(),
  ...storageEnv,
  ...redisEnv,
  ...rateLimitEnv,
  // Readiness only; the search adapter brings a scoped search key (never the master key).
  MEILI_URL: searchEnv.MEILI_URL,
  /** Search-only key (S1-F5) — never the master key in a request app. */
  MEILI_SEARCH_KEY: searchEnv.MEILI_SEARCH_KEY,
  /** Development only (production refuses it in request apps): network search without a provisioned search key. */
  MEILI_MASTER_KEY: searchEnv.MEILI_MASTER_KEY.optional(),
  /** Network search give-to-get (S5-05). */
  ...networkEnv,
  ...websitesEnv,
  // S12-07: the Meta app (connecting social accounts; H3).
  ...socialEnv,
  ...cryptoEnv,
  ...authVerifyEnv,
  /** Media preview URLs name variants by their public id (S3-06). */
  ...mediaEnv,
  /**
   * S12-04: the public pages' host (apps/public, `https://sites.inmolink.es`): selection links and their WhatsApp and
   * e-mail share links. Unset: the API answers the page's path only.
   */
  PUBLIC_PAGES_URL: z.url().optional(),
};
export type ApiConfig = Config<typeof apiEnv>;

/** The deployable decides its role, not the environment: api is always `http` (no `withSystem`). */
export const loadApiConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfigOrExit(apiEnv, { ...env, APP_ROLE: 'http' });
