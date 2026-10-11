import {
  authVerifyEnv,
  type Config,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  httpEnv,
  loadConfigOrExit,
  portVar,
  redisEnv,
  searchEnv,
  storageEnv,
  telemetryEnv,
} from '@inmolink/platform/config';

/**
 * Dashboard API: `app_user` (RLS) for tenant routes, `app_staff` (RLS, staff predicates) for staff
 * routes (S1-03), both Redis instances, search, object storage (verification documents).
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
  ...storageEnv,
  ...redisEnv,
  // Readiness only; the search adapter brings a scoped search key (never the master key).
  MEILI_URL: searchEnv.MEILI_URL,
  /** Search-only key (S1-F5) — never the master key in a request app. */
  MEILI_SEARCH_KEY: searchEnv.MEILI_SEARCH_KEY,
  ...cryptoEnv,
  ...authVerifyEnv,
};
export type ApiConfig = Config<typeof apiEnv>;

/** The deployable decides its role, not the environment: api is always `http` (no `withSystem`). */
export const loadApiConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfigOrExit(apiEnv, { ...env, APP_ROLE: 'http' });
