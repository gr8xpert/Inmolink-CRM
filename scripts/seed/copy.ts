import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

export type CopyValue = string | number | boolean | Date | null;

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** CSV cell for `copy … with (format csv)`: unquoted empty is NULL, everything else is quoted. */
function cell(value: CopyValue): string {
  if (value === null) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Idempotent bulk insert for seeds: skips rows whose key (the first column: `id`, or another unique
 * uuid column such as `agency_id` / `user_id`) already exists, COPYs the rest straight
 * into `table`. Runs inside the caller's transaction (`withSystemClient`). Seeds use deterministic
 * IDs, so a re-run finds every row and copies nothing. Feeds use staging + MERGE instead (§13).
 */
export async function copyNewRows(
  client: pg.PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly CopyValue[])[],
): Promise<number> {
  for (const name of [table, ...columns]) if (!IDENT.test(name)) throw new TypeError(`bad identifier ${name}`);
  const key = columns[0];
  if (!key) throw new TypeError('copyNewRows: the first column must be a unique uuid key');
  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r[0] as string);
  const existing = await client.query<{ id: string }>(
    `select ${key} as id from ${table} where ${key} = any($1::uuid[])`,
    [ids],
  );
  const skip = new Set(existing.rows.map((r) => r.id));
  const fresh = rows.filter((r) => !skip.has(r[0] as string));
  if (fresh.length === 0) return 0;

  const lines = function* () {
    for (const row of fresh) yield `${row.map(cell).join(',')}\n`;
  };
  await pipeline(
    Readable.from(lines()),
    client.query(copyFrom(`copy ${table} (${columns.join(', ')}) from stdin with (format csv)`)),
  );
  return fresh.length;
}
