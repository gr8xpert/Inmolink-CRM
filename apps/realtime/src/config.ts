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
  webUrlEnv,
} from '@inmolink/platform/config';

/** Socket.io server: `app_user` (membership checks, S11), redis-cache for the adapter's pub/sub. */
export const realtimeEnv = {
  ...coreEnv,
  ...httpEnv,
  REALTIME_PORT: portVar(4002),
  DATABASE_URL_APP_USER: databaseEnv.DATABASE_URL_APP_USER,
  REDIS_CACHE_URL: redisEnv.REDIS_CACHE_URL,
  ...cryptoEnv,
  ...authVerifyEnv,
  ...webUrlEnv,
};
export type RealtimeConfig = Config<typeof realtimeEnv>;

export const loadRealtimeConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfigOrExit(realtimeEnv, { ...env, APP_ROLE: 'http' });
