import {
  type Config,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  emailEnv,
  httpEnv,
  loadConfigOrExit,
  portVar,
  redisEnv,
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

export const workerEnv = {
  ...coreEnv,
  ...httpEnv,
  /** Comma list of pools this process runs, or `all`. */
  WORKER_POOLS: z
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
    }),
  /** Health server for the orchestrator (`/healthz`, `/readyz`); bind it to a private interface. */
  WORKER_HEALTH_PORT: portVar(4003),
  DATABASE_URL_APP_USER: databaseEnv.DATABASE_URL_APP_USER,
  // Required here (optional in platform): the outbox and cross-tenant jobs run `withSystem`.
  DATABASE_URL_APP_SYSTEM: databaseEnv.DATABASE_URL_APP_SYSTEM.unwrap(),
  DATABASE_URL_LISTEN: databaseEnv.DATABASE_URL_LISTEN,
  ...redisEnv,
  ...cryptoEnv,
  ...emailEnv,
  ...webUrlEnv,
};
export type WorkerConfig = Config<typeof workerEnv>;

/** platform/email driver settings from the validated env (cross-checks guarantee the credential). */
export function emailConfig(config: WorkerConfig): EmailConfig {
  return config.EMAIL_DRIVER === 'resend'
    ? { driver: 'resend', from: config.EMAIL_FROM, resendApiKey: config.RESEND_API_KEY as string }
    : { driver: 'smtp', from: config.EMAIL_FROM, smtpUrl: config.SMTP_URL as string };
}

export const loadWorkerConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfigOrExit(workerEnv, { ...env, APP_ROLE: 'worker' });
