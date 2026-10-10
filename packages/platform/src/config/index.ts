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
  /**
   * Direct (non-PgBouncer) session connection for LISTEN — the outbox dispatcher's wake-up.
   * Workers only (app_system credential); without it the dispatcher polls.
   */
  DATABASE_URL_LISTEN: url(['postgres', 'postgresql']).optional(),
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

export const searchEnv = {
  MEILI_URL: url(['http', 'https']),
  MEILI_MASTER_KEY: nonEmpty,
};

export const storageEnv = {
  S3_ENDPOINT: url(['http', 'https']),
  S3_REGION: nonEmpty,
  S3_ACCESS_KEY_ID: nonEmpty,
  S3_SECRET_ACCESS_KEY: nonEmpty,
  S3_BUCKET_MEDIA: nonEmpty,
  S3_BUCKET_EXPORTS: nonEmpty,
};

export const emailEnv = {
  SMTP_URL: url(['smtp', 'smtps']),
};

export const otelEnv = {
  OTEL_EXPORTER_OTLP_ENDPOINT: url(['http', 'https']).optional(),
};

export const cryptoEnv = {
  /** `keyId:base64Key[,keyId:base64Key…]` — 32-byte AES keys; see platform/crypto. */
  ENCRYPTION_KEYS: nonEmpty,
  ENCRYPTION_ACTIVE_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'must be a key id from ENCRYPTION_KEYS'),
  /** Dedicated HMAC key (fingerprints, idempotency keys); at least 32 chars. */
  HMAC_KEY: z.string().min(32, 'must be at least 32 characters'),
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
  if (production && cfg.APP_ROLE === 'http' && cfg.DATABASE_URL_LISTEN !== undefined) {
    problems.push({
      key: 'DATABASE_URL_LISTEN',
      message: 'must not be set for APP_ROLE=http in production (outbox dispatcher only; runs in workers)',
    });
  }
  if (production && typeof cfg.HMAC_KEY === 'string' && cfg.HMAC_KEY.startsWith('dev-')) {
    problems.push({ key: 'HMAC_KEY', message: 'dev keys ("dev-…") are not allowed in production' });
  }
  return problems;
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
