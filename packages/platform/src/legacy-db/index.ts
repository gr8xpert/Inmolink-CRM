import pg from 'pg';
import { z } from 'zod';

/**
 * Legacy database adapter (S15-F4, PLAN §14 Path A): the one door to the legacy Inmolink database (a PostgreSQL
 * dump restored or replicated read-only, H1). It can only read:
 *
 * - the session default is read-only (`default_transaction_read_only=on`) and every snapshot is one
 *   `REPEATABLE READ READ ONLY` transaction, so a stray write is refused by the server (25006);
 * - the login role must be a plain SELECT-only one (no superuser, no `pg_signal_backend`, no write / server-file
 *   roles, no CREATEROLE / CREATEDB / REPLICATION / BYPASSRLS): a read-only transaction does not stop side-effecting
 *   functions (`pg_terminate_backend`, advisory locks, `set_config`, dblink / foreign data wrappers), privileges do;
 * - the URL may not carry `options` or timeout parameters (pg lets URL parameters override the client config), and
 *   the statement / idle timeouts are set again inside the transaction;
 * - only `SELECT` / `WITH` statements without a `;` are accepted, before they leave the process;
 * - at most `maxConnections` snapshots are open per process (more wait, up to `acquireTimeoutMs`);
 * - large reads stream through a server-side cursor in batches, never as one result set;
 * - failures surface as `LegacyDbError` carrying a code only: a database or driver message may quote row data or
 *   the URL, and nothing in here logs a credential, a statement parameter or a row.
 */

/** Settings (env). `LEGACY_DATABASE_URL` unset: no legacy access, the hourly delta queues nothing. */
export const legacyDbEnv = {
  LEGACY_DATABASE_URL: z.string().trim().min(1).optional(),
  /** Longest a single legacy statement may run. */
  LEGACY_DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(600_000),
  /** Snapshots open at once in this process (each holds one connection and a transaction). */
  LEGACY_DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10).default(2),
};

export interface LegacyDbConfig {
  /** Connection string of the legacy database: `postgres://` of a dedicated SELECT-only role, without `options`. */
  url: string;
  statementTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** A snapshot left idle inside its transaction this long is ended by the server. */
  idleInTransactionTimeoutMs?: number;
  /** Snapshots open at once in this process. */
  maxConnections?: number;
  /** How long a call waits for a free connection slot before failing (default 30 s). */
  acquireTimeoutMs?: number;
  applicationName?: string;
}

/** A legacy database failure: a code (SQLSTATE or `LEGACY_DB_*`) and a fixed message, never the server's text. */
export class LegacyDbError extends Error {
  override name = 'LegacyDbError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

/** A validated, quoted identifier for a statement built by the caller (never string-concatenate anything else). */
export function legacyIdent(value: string, what: string): string {
  if (!IDENT.test(value)) throw new TypeError(`invalid ${what} identifier: ${JSON.stringify(value)}`);
  return pg.escapeIdentifier(value);
}

/** Stable JSON: sorted keys, Dates as ISO, bigint/Buffer as strings, so equal data gives equal bytes. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (Buffer.isBuffer(v)) return `base64:${v.toString('base64')}`;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

/**
 * Only this module's own error class passes through; anything else (pg errors, `TypeError`, `ERR_INVALID_URL`) is
 * wrapped with its SQLSTATE and a fixed message, since the original text may quote the URL, a row or a credential.
 */
const sanitize = (err: unknown): LegacyDbError => {
  if (err instanceof LegacyDbError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const state = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  return new LegacyDbError(state ?? 'LEGACY_DB_ERROR', `legacy database error${state ? ` (${state})` : ''}`);
};

const READ_ONLY_SQL = /^\s*(select|with)\b/i;

/**
 * Only a single SELECT / WITH reaches the legacy database. Values never go into the text: they go through `params`
 * (a `;` or a quote in a value would otherwise be statement syntax). The `;` check only guards against a second
 * statement; it is not an escaping layer.
 */
export function assertReadOnlySql(sql: string): void {
  if (!READ_ONLY_SQL.test(sql) || sql.includes(';')) {
    throw new LegacyDbError('LEGACY_DB_READ_ONLY', 'only a single SELECT statement may run on the legacy database');
  }
}

// Per-process connection limit (a plain counting gate; waiters run in arrival order).
let activeConnections = 0;
const waiting: (() => void)[] = [];
async function acquire(max: number, timeoutMs: number): Promise<void> {
  if (activeConnections < max) {
    activeConnections += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const wake = () => {
      clearTimeout(timer);
      resolve(); // the slot was handed over by `release`
    };
    const timer = setTimeout(() => {
      const i = waiting.indexOf(wake);
      if (i >= 0) waiting.splice(i, 1);
      reject(new LegacyDbError('LEGACY_DB_BUSY', 'no legacy database connection became free in time'));
    }, timeoutMs);
    waiting.push(wake);
  });
}
function release(): void {
  const next = waiting.shift();
  if (next)
    next(); // the slot passes straight to the next waiter
  else activeConnections -= 1;
}

/** Snapshots open in this process (tests, health). */
export function legacyDbConnections(): number {
  return activeConnections;
}

/** URL parameters pg would let override the client config below (timeouts, session options). */
const FORBIDDEN_URL_PARAMS = /^(options|.*timeout.*)$/i;

function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LegacyDbError('LEGACY_DB_BAD_URL', 'the legacy database URL is not a valid postgres:// URL');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new LegacyDbError('LEGACY_DB_BAD_URL', 'the legacy database URL is not a valid postgres:// URL');
  }
  for (const key of parsed.searchParams.keys()) {
    if (FORBIDDEN_URL_PARAMS.test(key)) {
      throw new LegacyDbError('LEGACY_DB_BAD_URL', 'the legacy database URL may not set options or timeouts');
    }
  }
}

function connect(config: LegacyDbConfig): pg.Client {
  assertSafeUrl(config.url);
  return new pg.Client({
    connectionString: config.url,
    connectionTimeoutMillis: config.connectTimeoutMs ?? 10_000,
    options: '-c default_transaction_read_only=on',
    application_name: config.applicationName ?? 'inmolink-legacy-reader',
  });
}

/**
 * The login role must be a plain SELECT-only one. A read-only transaction stops writes but not side-effecting
 * functions (terminate a backend, advisory locks, `set_config`, dblink / FDW calls): privileges do.
 */
async function assertSelectOnlyRole(client: pg.Client): Promise<void> {
  const res = await client.query<{ bad: boolean }>(
    `SELECT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
        OR pg_has_role(r.oid, 'pg_signal_backend', 'MEMBER')
        OR pg_has_role(r.oid, 'pg_write_all_data', 'MEMBER')
        OR pg_has_role(r.oid, 'pg_execute_server_program', 'MEMBER')
        OR pg_has_role(r.oid, 'pg_read_server_files', 'MEMBER')
        OR pg_has_role(r.oid, 'pg_write_server_files', 'MEMBER')) AS bad
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  if (res.rows[0]?.bad !== false) {
    throw new LegacyDbError(
      'LEGACY_DB_ROLE_NOT_SELECT_ONLY',
      'the legacy database login must be a dedicated SELECT-only role (see HUMAN-ACTIONS H1)',
    );
  }
}

/** One consistent read-only view of the legacy database. */
export interface LegacySnapshot {
  /** The legacy database's clock when the snapshot began: rows committed before it are in the view. */
  readonly snapshotAt: Date;
  /** Runs one SELECT and returns all its rows (small results only; use `stream` for tables). */
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Runs one SELECT through a server-side cursor, yielding rows in batches of `batchSize`. A cursor takes no bind
   * parameters, so `$n` are inlined as escaped literals: the statement text may not contain quotes, comments or `$$`.
   */
  stream<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[],
    batchSize: number,
  ): AsyncIterable<T[]>;
  close(): Promise<void>;
}

/** `$n` placeholders as literals (scalars only); a missing or out-of-range index is an error. */
function inlineParams(sql: string, params: readonly unknown[]): string {
  // No quote, comment or dollar-quote in the template: every `$n` is code, never text inside a literal.
  if (/['\\]|--|\/\*|\$\$|\$[A-Za-z_]/.test(sql)) {
    throw new LegacyDbError('LEGACY_DB_BAD_PARAM', 'a cursor statement may not contain quotes, comments or $$');
  }
  return sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const i = Number(n);
    if (i < 1 || i > params.length) throw new LegacyDbError('LEGACY_DB_BAD_PARAM', `cursor parameter $${n} is missing`);
    const v = params[i - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' && Number.isFinite(v)) return `(${v})`;
    if (typeof v === 'bigint') return `(${v})`;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Date && !Number.isNaN(v.getTime())) return `${pg.escapeLiteral(v.toISOString())}::timestamptz`;
    if (typeof v === 'string') return pg.escapeLiteral(v);
    throw new LegacyDbError('LEGACY_DB_BAD_PARAM', `unsupported cursor parameter $${n}`);
  });
}

/** Opens a read-only snapshot (`REPEATABLE READ READ ONLY`). Always `close()` it: that frees the connection slot. */
export async function openLegacySnapshot(config: LegacyDbConfig): Promise<LegacySnapshot> {
  await acquire(Math.max(1, Math.trunc(config.maxConnections ?? 2)), config.acquireTimeoutMs ?? 30_000);
  let client: pg.Client | undefined;
  let closed = false;
  // From here the slot is ours: whatever fails below (bad URL, connect, role check) goes through `close`.
  const close = async () => {
    if (closed) return;
    closed = true;
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      await client.end().catch(() => {});
    }
    release();
  };
  try {
    const c = connect(config);
    client = c;
    await c.connect();
    await assertSelectOnlyRole(c);
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Not the URL's: pg lets URL parameters override the client config, so the limits are set inside the transaction.
    await c.query(`SET LOCAL statement_timeout = ${Math.trunc(config.statementTimeoutMs ?? 600_000)}`);
    await c.query(
      `SET LOCAL idle_in_transaction_session_timeout = ${Math.trunc(config.idleInTransactionTimeoutMs ?? 1_800_000)}`,
    );
    const ro = await c.query<{ v: string }>('SELECT current_setting($1) AS v', ['transaction_read_only']);
    if (ro.rows[0]?.v !== 'on') throw new LegacyDbError('LEGACY_DB_READ_ONLY', 'legacy connection is not read-only');
    // now() is the transaction's start: every row committed before it is in this snapshot.
    const clock = await c.query<{ now: Date }>('SELECT now() AS now');
    const snapshotAt = clock.rows[0]?.now as Date;
    let cursors = 0;

    return {
      snapshotAt,
      async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
        assertReadOnlySql(sql);
        try {
          return (await c.query(sql, params)).rows as T[];
        } catch (err) {
          throw sanitize(err);
        }
      },
      async *stream<T extends Record<string, unknown>>(sql: string, params: unknown[], batchSize: number) {
        assertReadOnlySql(sql);
        const size = Math.max(1, Math.trunc(batchSize));
        cursors += 1;
        const name = `legacy_cursor_${cursors}`;
        const declared = inlineParams(sql, params);
        try {
          await c.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${declared}`);
          for (;;) {
            const page = await c.query(`FETCH FORWARD ${size} FROM ${name}`);
            if (page.rows.length === 0) break;
            yield page.rows as T[];
            if (page.rows.length < size) break;
          }
          await c.query(`CLOSE ${name}`);
        } catch (err) {
          throw sanitize(err);
        }
      },
      close,
    };
  } catch (err) {
    await close();
    throw sanitize(err);
  }
}
