import { type Config, coreEnv, databaseEnv, loadConfig } from '@inmolink/platform/config';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { RuntimeRole } from './roles';
import * as schema from './schema';

/**
 * One pg pool + Drizzle instance per runtime role, created on first use (PLAN §3 #50).
 * URLs point at PgBouncer (transaction mode), so nothing here may rely on session state:
 * tenant settings are transaction-local (see tenancy/scope.ts).
 */
export const dbEnv = { ...coreEnv, ...databaseEnv };
/**
 * Each app passes only the role URLs it may use — feed-api only `DATABASE_URL_APP_PUBLIC` (S0-08),
 * so its process cannot open an `app_user` pool at all. A missing URL fails on first use.
 */
export type DbConfig = Pick<Config<typeof dbEnv>, 'APP_ROLE'> &
  Partial<Pick<Config<typeof dbEnv>, keyof typeof databaseEnv>>;

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const ROLE_URL: Record<RuntimeRole, keyof typeof databaseEnv> = {
  app_user: 'DATABASE_URL_APP_USER',
  app_system: 'DATABASE_URL_APP_SYSTEM',
  app_public: 'DATABASE_URL_APP_PUBLIC',
  app_auth: 'DATABASE_URL_APP_AUTH',
};

export interface PoolOptions {
  /** Connections per role per process. PgBouncer multiplexes them onto its own server pool. */
  max?: number;
  /** Idle-connection errors (PgBouncer restart, failover) and `withSystem` audit lines. Defaults to a `db` logger. */
  logger?: Pick<Logger, 'warn' | 'info' | 'debug'>;
}

let config: DbConfig | undefined;
let poolOptions: PoolOptions = {};
const dbs = new Map<RuntimeRole, Db>();

/**
 * Sets the config used by every pool. Apps call it once at boot with their loaded config;
 * without it the first query loads `process.env`. Calling it again closes existing pools.
 */
export async function configureDb(next: DbConfig, options: PoolOptions = {}): Promise<void> {
  await closeDb();
  config = next;
  poolOptions = options;
}

export function dbConfig(): DbConfig {
  config ??= loadConfig(dbEnv);
  return config;
}

export function dbLogger(): Pick<Logger, 'warn' | 'info' | 'debug'> {
  poolOptions.logger ??= createLogger({ service: 'db', level: process.env.LOG_LEVEL });
  return poolOptions.logger;
}

/** Throws in request paths: `app_system` bypasses RLS and is for workers and scripts only. */
export function assertSystemAllowed(appRole: DbConfig['APP_ROLE'] = dbConfig().APP_ROLE): void {
  if (appRole === 'http') throw new Error('app_system (withSystem) is not allowed when APP_ROLE=http');
}

export function getDb(role: RuntimeRole): Db {
  if (role === 'app_system') assertSystemAllowed();
  let db = dbs.get(role);
  if (!db) {
    const connectionString = dbConfig()[ROLE_URL[role]];
    if (!connectionString) throw new Error(`${ROLE_URL[role]} is not set; ${role} is unavailable in this process`);
    const pool = new pg.Pool({
      connectionString,
      max: poolOptions.max ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Without a listener, an error on an idle client is unhandled and crashes the process.
    // The pool discards the broken client; the next checkout opens a fresh one.
    pool.on('error', (err) => dbLogger().warn({ err, role }, 'idle pg client error'));
    // pg-pool drops its listener while a client is checked out; a connection that dies between two
    // queries of a transaction (Postgres restart, failover) would then crash the process with an
    // unhandled 'error'. The pending or next query still rejects, and the pool discards the client.
    pool.on('connect', (client) => {
      client.on('error', (err) => dbLogger().warn({ err, role }, 'pg client error'));
    });
    db = drizzle({ client: pool, schema });
    dbs.set(role, db);
  }
  return db;
}

/**
 * Raw pooled client for COPY streams and other driver-level work (PATTERNS §13). The caller
 * owns the transaction, sets `app.agency_id` with `set_config(…, true)` inside it, and releases.
 */
export async function getPgClient(role: RuntimeRole): Promise<pg.PoolClient> {
  return getDb(role).$client.connect();
}

/**
 * Readiness: one `select 1` on the role's pool (through PgBouncer, so a stopped Postgres fails here
 * even while PgBouncer accepts the connection). Callers bound it with their own timeout.
 */
export async function pingDb(role: RuntimeRole): Promise<void> {
  await getDb(role).$client.query('select 1');
}

/** Graceful shutdown: drains every pool. */
export async function closeDb(): Promise<void> {
  const open = [...dbs.values()];
  dbs.clear();
  await Promise.all(open.map((db) => db.$client.end()));
}
