// Checks every local-stack service (docker-compose.yml) and exits non-zero if any is down or misconfigured.
//   pnpm infra:health        → dev profile (.env, falling back to .env.example)
//   pnpm infra:health:test   → test profile (.env.test, falling back to .env.test.example)
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';
import { readStackEnv, type StackEnv, type StackTarget } from './stack-env';

/** Keep in sync with infra/docker/postgres/initdb/01-extensions.sql. */
export const REQUIRED_EXTENSIONS = ['postgis', 'vector', 'pg_trgm', 'pg_partman', 'pg_stat_statements'] as const;

const TIMEOUT_MS = 5_000;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

type Check = { name: string; run: (env: StackEnv) => Promise<string> };

function required(env: StackEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

async function withPg<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: TIMEOUT_MS });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function redisConfig(url: string, keys: string[]): Promise<Record<string, string>> {
  const redis = new Redis(url, {
    protocol: 2,
    lazyConnect: true,
    connectTimeout: TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    const out: Record<string, string> = {};
    for (const key of keys) {
      const [, value = ''] = (await redis.config('GET', key)) as string[];
      out[key] = value;
    }
    return out;
  } finally {
    redis.disconnect();
  }
}

async function httpOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res;
}

/** Opens a TCP connection and returns the server's first line (SMTP greets with "220 …"). */
function tcpBanner(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: TIMEOUT_MS });
    socket.once('data', (data) => {
      socket.end();
      resolve(data.toString('utf8').split('\r\n')[0] ?? '');
    });
    socket.once('timeout', () => socket.destroy(new Error(`${host}:${port} timed out`)));
    socket.once('error', reject);
  });
}

const POSTGRES: Check = {
  name: 'postgres',
  run: (env) =>
    withPg(required(env, 'DATABASE_URL_ADMIN'), async (client) => {
      const version = await client.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
      const { rows } = await client.query<{ extname: string }>('SELECT extname FROM pg_extension');
      const installed = new Set(rows.map((r) => r.extname));
      const missing = REQUIRED_EXTENSIONS.filter((e) => !installed.has(e));
      if (missing.length > 0) throw new Error(`missing extensions: ${missing.join(', ')}`);
      return `PostgreSQL ${version.rows[0]?.v}; extensions ${REQUIRED_EXTENSIONS.join(', ')}`;
    }),
};

const PGBOUNCER: Check = {
  name: 'pgbouncer',
  run: async (env) => {
    const url = new URL(required(env, 'DATABASE_URL_ADMIN_POOLED'));
    await withPg(url.href, (client) => client.query('SELECT 1'));
    url.pathname = '/pgbouncer';
    const mode = await withPg(url.href, async (client) => {
      const { rows } = await client.query<{ key: string; value: string }>('SHOW CONFIG');
      return rows.find((r) => r.key === 'pool_mode')?.value;
    });
    if (mode !== 'transaction') throw new Error(`pool_mode is ${mode}, expected transaction`);
    return 'query ok; pool_mode=transaction';
  },
};

const REDIS_QUEUE: Check = {
  name: 'redis-queue',
  run: async (env) => {
    const cfg = await redisConfig(required(env, 'REDIS_QUEUE_URL'), ['maxmemory-policy', 'appendonly']);
    if (cfg['maxmemory-policy'] !== 'noeviction') throw new Error(`maxmemory-policy=${cfg['maxmemory-policy']}`);
    if (cfg.appendonly !== 'yes') throw new Error(`appendonly=${cfg.appendonly}`);
    return 'noeviction; AOF on';
  },
};

const REDIS_CACHE: Check = {
  name: 'redis-cache',
  run: async (env) => {
    const cfg = await redisConfig(required(env, 'REDIS_CACHE_URL'), ['maxmemory-policy']);
    if (cfg['maxmemory-policy'] !== 'allkeys-lru') throw new Error(`maxmemory-policy=${cfg['maxmemory-policy']}`);
    return 'allkeys-lru';
  },
};

const MEILISEARCH: Check = {
  name: 'meilisearch',
  run: async (env) => {
    const base = required(env, 'MEILI_URL');
    await httpOk(`${base}/health`);
    const headers = { Authorization: `Bearer ${required(env, 'MEILI_MASTER_KEY')}` };
    const { pkgVersion } = (await (await httpOk(`${base}/version`, { headers })).json()) as { pkgVersion: string };
    return `v${pkgVersion}; master key accepted`;
  },
};

const MINIO: Check = {
  name: 'minio',
  run: async (env) => {
    await httpOk(`${required(env, 'S3_ENDPOINT')}/minio/health/live`);
    return 'live';
  },
};

const MAILPIT: Check = {
  name: 'mailpit',
  run: async (env) => {
    const smtp = new URL(required(env, 'SMTP_URL'));
    const banner = await tcpBanner(smtp.hostname, Number(smtp.port));
    if (!banner.startsWith('220')) throw new Error(`unexpected SMTP greeting: ${banner}`);
    const { Version } = (await (await httpOk(`${required(env, 'MAILPIT_URL')}/api/v1/info`)).json()) as {
      Version: string;
    };
    return `SMTP ready; ${Version}`;
  },
};

const OTEL_COLLECTOR: Check = {
  name: 'otel-collector',
  run: async (env) => {
    await httpOk(required(env, 'OTEL_COLLECTOR_HEALTH_URL'));
    return 'ready';
  },
};

const JAEGER: Check = {
  name: 'jaeger',
  run: async (env) => {
    await httpOk(required(env, 'JAEGER_UI_URL'));
    return 'UI up';
  },
};

/** Services each compose profile must provide. Tracing is dev-only. */
export const CHECKS: Record<StackTarget, readonly Check[]> = {
  dev: [POSTGRES, PGBOUNCER, REDIS_QUEUE, REDIS_CACHE, MEILISEARCH, MINIO, MAILPIT, OTEL_COLLECTOR, JAEGER],
  test: [POSTGRES, PGBOUNCER, REDIS_QUEUE, REDIS_CACHE, MEILISEARCH, MINIO, MAILPIT],
};

/** Connection refusals arrive as an AggregateError (one per IPv4/IPv6 address) with an empty message. */
function errorDetail(err: unknown): string {
  if (err instanceof AggregateError) return [...new Set(err.errors.map(errorDetail))].join('; ');
  if (err instanceof Error) return err.message || ('code' in err ? String(err.code) : err.name);
  return String(err);
}

export async function checkStack(target: StackTarget, env: StackEnv = readStackEnv(target)): Promise<CheckResult[]> {
  return Promise.all(
    CHECKS[target].map(async ({ name, run }) => {
      try {
        return { name, ok: true, detail: await run(env) };
      } catch (err) {
        return { name, ok: false, detail: errorDetail(err) };
      }
    }),
  );
}

async function main(): Promise<void> {
  const target: StackTarget = process.argv.includes('--test') ? 'test' : 'dev';
  const results = await checkStack(target);
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `\n${target} stack healthy` : `\n${failed} check(s) failed (${target} stack)`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
