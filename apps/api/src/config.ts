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
} from '@inmolink/platform/config';

/** Dashboard API: `app_user` only (RLS), both Redis instances, search. */
export const apiEnv = {
  ...coreEnv,
  ...httpEnv,
  API_PORT: portVar(4000),
  DATABASE_URL_APP_USER: databaseEnv.DATABASE_URL_APP_USER,
  ...redisEnv,
  // Readiness only; the search adapter brings a scoped search key (never the master key).
  MEILI_URL: searchEnv.MEILI_URL,
  ...cryptoEnv,
  ...authVerifyEnv,
};
export type ApiConfig = Config<typeof apiEnv>;

/** The deployable decides its role, not the environment: api is always `http` (no `withSystem`). */
export const loadApiConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfigOrExit(apiEnv, { ...env, APP_ROLE: 'http' });
