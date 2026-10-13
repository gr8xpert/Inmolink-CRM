import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { readStackEnv } from '../../scripts/ops/stack-env';

const ROOT = join(import.meta.dirname, '..', '..');
const env = readStackEnv('test');
const ini = readFileSync(join(ROOT, 'infra', 'docker', 'pgbouncer', 'common.ini'), 'utf8');
const setting = (name: string) => Number(ini.match(new RegExp(`^${name} = (\\d+)$`, 'm'))?.[1]);

/**
 * The `postgres` database through PgBouncer: its own pool, which no other test uses, so saturating it
 * never starves a parallel test file.
 */
function pooledPostgresDb(): pg.ClientConfig {
  const url = new URL(env.DATABASE_URL_ADMIN_POOLED as string);
  url.pathname = '/postgres';
  return { connectionString: url.href, application_name: 'pool-saturation-test' };
}

async function connect(config: pg.ClientConfig): Promise<pg.Client> {
  const client = new pg.Client(config);
  client.on('error', () => {}); // PgBouncer closes the waiting client after query_wait_timeout
  await client.connect();
  return client;
}

describe('connection pool', () => {
  it('[S1-F6] a saturated pool returns an error within 6 s instead of waiting 120 s', { timeout: 30_000 }, async () => {
    const poolSize = setting('default_pool_size');
    const holdSeconds = 8;
    const holders = await Promise.all(Array.from({ length: poolSize }, () => connect(pooledPostgresDb())));
    const waiter = await connect(pooledPostgresDb());
    try {
      // Every server connection of the pool is busy for `holdSeconds`.
      const busy = holders.map((c) => c.query(`select pg_sleep(${holdSeconds})`).catch(() => undefined));
      await new Promise((r) => setTimeout(r, 300));

      const started = performance.now();
      const err = await waiter.query('select 1').then(
        () => undefined,
        (e: unknown) => e,
      );
      const waited = performance.now() - started;

      expect(err, 'the query should fail while the pool is saturated').toBeInstanceOf(Error);
      expect(String((err as Error).message)).toMatch(/query_wait_timeout/);
      expect(waited).toBeLessThan(6_000);
      expect(waited).toBeGreaterThan(setting('query_wait_timeout') * 1_000 - 1_500);
      await Promise.all(busy);
    } finally {
      await Promise.all([...holders, waiter].map((c) => c.end().catch(() => undefined)));
    }
  });

  it('[S1-F6] PgBouncer opens fewer server connections than Postgres allows', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    const maxConnections = Number(compose.match(/max_connections=(\d+)/)?.[1]);
    expect(setting('max_db_connections')).toBeGreaterThan(0);
    expect(setting('max_db_connections')).toBeLessThan(maxConnections);

    const prod = readFileSync(join(ROOT, 'infra/ansible/roles/postgres/templates/pgbouncer.ini.j2'), 'utf8');
    expect(prod).toMatch(/^query_wait_timeout = 5$/m);
    expect(prod).toMatch(/^max_db_connections = \{\{ pgbouncer_max_db_connections \}\}$/m);
  });

  it('[S1-F6] a transaction left idle past the timeout is ended by the server', async () => {
    // Same mechanism as the role setting, with a 1 s timeout so the test stays fast.
    const client = await connect({ connectionString: env.DATABASE_URL_APP_USER });
    try {
      await client.query('begin');
      await client.query(`set local idle_in_transaction_session_timeout = '1s'`);
      await new Promise((r) => setTimeout(r, 1_800));
      await expect(client.query('select 1')).rejects.toThrow();
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  it('[S1-F6] request roles end a transaction left idle for 15 s', async () => {
    for (const key of [
      'DATABASE_URL_APP_USER',
      'DATABASE_URL_APP_AUTH',
      'DATABASE_URL_APP_STAFF',
      'DATABASE_URL_APP_PUBLIC',
    ]) {
      const client = await connect({ connectionString: env[key] });
      try {
        const { rows } = await client.query<{ v: string }>(
          `select current_setting('idle_in_transaction_session_timeout') as v`,
        );
        expect(rows[0]?.v, key).toBe('15s');
      } finally {
        await client.end();
      }
    }
  });
});
