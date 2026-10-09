import { randomInt } from 'node:crypto';
import { newId } from '@inmolink/platform/ids';
import { type SQL, sql } from 'drizzle-orm';
import type pg from 'pg';

/**
 * Generic rows for any registered table: NOT NULL columns without a default get an invented value
 * by type, registry overrides win. Seeds go through the superuser with FK triggers off
 * (`session_replication_role = replica`), so a table's parents need not exist.
 */

interface Column {
  name: string;
  type: string;
  category: string;
  required: boolean;
  labels: string[] | null;
}

export type Row = Record<string, unknown>;

export async function columnsOf(client: pg.ClientBase, table: string): Promise<Column[]> {
  const { rows } = await client.query<Column>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, t.typcategory as category,
            (a.attnotnull and not a.atthasdef and a.attidentity = '' and a.attgenerated = '') as required,
            (select array_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = a.atttypid) as labels
       from pg_attribute a join pg_type t on t.oid = a.atttypid
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped`,
    [`public.${table}`],
  );
  return rows;
}

function invent(table: string, c: Column): unknown {
  if (c.type === 'uuid') return newId();
  if (c.type === 'jsonb' || c.type === 'json') return {};
  const fixed = /^character\((\d+)\)$/.exec(c.type);
  if (fixed) return 'X'.repeat(Number(fixed[1]));
  switch (c.category) {
    case 'S':
      return `iso-${randomInt(1e9)}`;
    case 'N':
      return randomInt(1, 100_000);
    case 'B':
      return false;
    case 'D':
      return new Date();
    case 'E':
      return c.labels?.[0];
    case 'A':
      return '{}';
  }
  throw new Error(`cannot invent ${table}.${c.name} (${c.type}): add it to the registry entry's \`base\``);
}

/** A full row for `table`: invented required values, then `overrides`. */
export function buildRow(table: string, columns: Column[], overrides: Row): Row {
  const row: Row = {};
  for (const c of columns) if (c.required && !(c.name in overrides)) row[c.name] = invent(table, c);
  return { ...row, ...overrides };
}

/** Parameterized `insert` for raw pg clients. */
export function insertQuery(table: string, row: Row): { text: string; values: unknown[] } {
  const cols = Object.keys(row);
  return {
    text: `insert into "${table}" (${cols.map((c) => `"${c}"`).join(', ')})
           values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    values: Object.values(row),
  };
}

/** Inserts as superuser with FK checks off; returns the row's ctid (for global-table cleanup). */
export async function seed(admin: pg.ClientBase, table: string, row: Row): Promise<string> {
  const q = insertQuery(table, row);
  const { rows } = await admin.query<{ ctid: string }>(`${q.text} returning ctid::text as ctid`, q.values);
  return rows[0]?.ctid as string;
}

/**
 * Every write as `app_public` in a READ WRITE transaction, so the read-only default cannot mask a
 * missing privilege boundary: each must fail with insufficient_privilege. Always rolled back.
 */
export async function expectNoPublicWrites(client: pg.ClientBase, table: string, row: Row, column: string) {
  const q = insertQuery(table, row);
  const writes: [string, unknown[]][] = [
    [q.text, q.values],
    [`update "${table}" set "${column}" = "${column}"`, []],
    [`delete from "${table}"`, []],
    [`truncate "${table}"`, []],
  ];
  await client.query('begin read write');
  try {
    for (const [text, values] of writes) {
      await client.query('savepoint w');
      await expectSqlState(() => client.query(text, values), ['42501']);
      await client.query('rollback to savepoint w');
    }
  } finally {
    await client.query('rollback');
  }
}

export async function withReplicaRole<T>(admin: pg.ClientBase, fn: () => Promise<T>): Promise<T> {
  await admin.query('begin');
  try {
    await admin.query(`set local session_replication_role = replica`);
    const out = await fn();
    await admin.query('commit');
    return out;
  } catch (err) {
    await admin.query('rollback');
    throw err;
  }
}

/** Drizzle `insert` for app-role paths (withTenant / withPublicRead). */
export function insertSql(table: string, row: Row): SQL {
  const cols = Object.keys(row);
  return sql`insert into ${sql.identifier(table)} (${sql.join(
    cols.map((c) => sql.identifier(c)),
    sql`, `,
  )}) values (${sql.join(
    cols.map((c) => sql`${row[c]}`),
    sql`, `,
  )})`;
}

/** SQLSTATE of a pg error, also when wrapped by drizzle. */
export function sqlState(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Runs `fn`, expects it to fail with one of `codes`. */
export async function expectSqlState(fn: () => Promise<unknown>, codes: string[]): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const code = sqlState(err);
    if (code && codes.includes(code)) return code;
    throw err;
  }
  throw new Error(`expected SQLSTATE ${codes.join(' or ')}, but the statement succeeded`);
}
