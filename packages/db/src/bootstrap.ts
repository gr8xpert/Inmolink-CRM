import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { DB_ROLES, type DbRoleName } from './roles';

/**
 * Idempotent role setup, run by `pnpm db:migrate` as the bootstrap superuser before migrations.
 * Role passwords come from the role URLs (DATABASE_URL_APP_*), so the env stays the single source.
 * Production roles are provisioned the same way once, by ops, with the admin URL (S0-15).
 */
export interface RoleCredential {
  role: DbRoleName;
  password: string;
}

type Escape = { literal: (v: string) => string; ident: (v: string) => string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Local defaults from the committed env examples; never accepted for a non-local database. */
const LOCAL_ONLY_PASSWORDS = new Set(['change-me', 'postgres']);

/** Reads the role and password from a role URL and checks the user matches the expected role. */
export function credentialFromUrl(role: DbRoleName, url: string): RoleCredential {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The native error carries the full URL (password included) — never rethrow it.
    throw new Error(`URL for ${role} is not a valid URL`);
  }
  const user = decodeURIComponent(parsed.username);
  if (user !== role) throw new Error(`URL for ${role} connects as "${user}"; expected "${role}"`);
  const password = decodeURIComponent(parsed.password);
  if (!password) throw new Error(`URL for ${role} has no password`);
  if (LOCAL_ONLY_PASSWORDS.has(password) && !LOOPBACK.has(parsed.hostname)) {
    throw new Error(`URL for ${role} uses a local default password against a non-local host`);
  }
  return { role, password };
}

/**
 * SCRAM-SHA-256 verifier in PostgreSQL's stored format, computed client-side so the plaintext
 * never reaches the server (statement logs, pg_stat_statements). ASCII only: PostgreSQL applies
 * SASLprep, which leaves ASCII unchanged, so the verifier matches what the server would compute.
 */
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('role passwords must be printable ASCII');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

/** Statements for one role, after it exists. Pure, so the shape is unit-tested without a database. */
export function roleStatements(database: string, role: DbRoleName, verifier: string, esc: Escape): string[] {
  const spec = DB_ROLES[role];
  const r = esc.ident(role);
  const db = esc.ident(database);
  const out = [
    `alter role ${r} with login nosuperuser nocreatedb nocreaterole noinherit noreplication ` +
      `${spec.bypassRls ? 'bypassrls' : 'nobypassrls'} password ${esc.literal(verifier)}`,
    spec.statementTimeout
      ? `alter role ${r} set statement_timeout = ${esc.literal(spec.statementTimeout)}`
      : `alter role ${r} reset statement_timeout`,
    spec.readOnly
      ? `alter role ${r} set default_transaction_read_only = on`
      : `alter role ${r} reset default_transaction_read_only`,
    // No "$user" schema first: nobody can shadow public objects with a schema named after a role.
    `alter role ${r} set search_path = public`,
    `grant connect on database ${db} to ${r}`,
    // TEMPORARY is not granted: temp tables outlive a transaction on a PgBouncer server connection.
    // The bulk-load task adds it together with a helper that only creates `on commit drop` tables.
    `revoke temporary on database ${db} from ${r}`,
    `grant usage on schema public to ${r}`,
  ];
  if (role === 'app_owner') {
    // Creates the `drizzle` migrations schema and every app table.
    out.push(`grant create on database ${db} to ${r}`, `grant create on schema public to ${r}`);
  }
  if (spec.dml) {
    out.push(
      `alter default privileges for role app_owner in schema public grant select, insert, update, delete on tables to ${r}`,
      `alter default privileges for role app_owner in schema public grant usage, select on sequences to ${r}`,
      `alter default privileges for role app_owner in schema public grant execute on functions to ${r}`,
    );
  }
  return out;
}

/**
 * Database-wide hardening: only the app roles may connect, nobody else creates objects, and
 * functions are not executable by PUBLIC (app_public gets EXECUTE per function, like SELECT per table).
 */
export function databaseStatements(database: string, esc: Escape): string[] {
  const db = esc.ident(database);
  return [
    `revoke connect, temporary on database ${db} from public`,
    'revoke create on schema public from public',
    'alter default privileges for role app_owner in schema public revoke execute on functions from public',
  ];
}

/** Creates or updates every role and grant. Caller holds the migration lock. */
export async function bootstrapRoles(admin: pg.ClientBase, creds: RoleCredential[]): Promise<void> {
  const esc: Escape = { literal: (v) => admin.escapeLiteral(v), ident: (v) => admin.escapeIdentifier(v) };
  const { rows } = await admin.query<{ db: string }>('select current_database() as db');
  const database = rows[0]?.db;
  if (!database) throw new Error('could not read current_database()');

  await admin.query('begin');
  try {
    // Owner first: the default-privilege grants of the other roles reference it.
    const ordered = [...creds].sort((a, b) => Number(b.role === 'app_owner') - Number(a.role === 'app_owner'));
    for (const cred of ordered) {
      const exists = await admin.query('select 1 from pg_roles where rolname = $1', [cred.role]);
      if (exists.rowCount === 0) await admin.query(`create role ${esc.ident(cred.role)}`);
      for (const stmt of roleStatements(database, cred.role, scramVerifier(cred.password), esc)) {
        await admin.query(stmt);
      }
    }
    // App roles are never members of anything (NOINHERIT does not stop SET ROLE).
    const names = creds.map((c) => c.role);
    const memberships = await admin.query<{ granted: string; member: string }>(
      `select g.rolname as granted, m.rolname as member
         from pg_auth_members a join pg_roles g on g.oid = a.roleid join pg_roles m on m.oid = a.member
        where m.rolname = any($1)`,
      [names],
    );
    for (const { granted, member } of memberships.rows) {
      await admin.query(`revoke ${esc.ident(granted)} from ${esc.ident(member)}`);
    }
    for (const stmt of databaseStatements(database, esc)) await admin.query(stmt);
    await admin.query('commit');
  } catch (err) {
    await admin.query('rollback');
    throw err;
  }
}
