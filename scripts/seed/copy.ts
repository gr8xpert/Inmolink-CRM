import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

export type CopyValue = string | number | boolean | Date | null;

const IDENT = /^[a-z_][a-z0-9_]*$/;
const COPY_BUFFER_CHARS = 1 << 20;
const ROWS_PER_CHUNK = 5_000;
/** Chunks in flight at once: one builds rows in JS while others COPY. Below the 10-connection pool. */
const PARALLEL_CHUNKS = 4;

/**
 * Agencies per transaction for a seeder writing `rowsPerAgency` rows each: at least `--chunk`, and
 * enough for about 5k rows, so low-ratio tables (5 users per agency) do not pay a transaction per
 * 500 rows (S1-F6). High-ratio seeders (media) get exactly `--chunk`.
 */
export function agenciesPerChunk(chunk: number, rowsPerAgency: number): number {
  return Math.max(chunk, Math.ceil(ROWS_PER_CHUNK / Math.max(1, rowsPerAgency)));
}

/**
 * Runs `write(start, end)` for each chunk of `[0, count)`, up to four transactions at a time, and sums
 * what they return. Chunks are independent (deterministic IDs, existing rows skipped), so their order
 * does not matter and an interrupted run still resumes. `onProgress` gets the number of agencies done.
 */
export async function forEachChunk(
  count: number,
  step: number,
  write: (start: number, end: number) => Promise<number>,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let next = 0;
  let done = 0;
  let total = 0;
  let failed = false;
  const lane = async () => {
    // After one lane fails, the others finish their current chunk and stop, so no write outlives the run.
    while (next < count && !failed) {
      const start = next;
      const end = Math.min(count, start + step);
      next = end;
      // Not `total += await …`: that reads `total` before the await and loses the other lanes' rows.
      const written = await write(start, end).catch((err: unknown) => {
        failed = true;
        throw err;
      });
      total += written;
      done += end - start;
      onProgress?.(done, count);
    }
  };
  // allSettled, not all: the caller may close the pool on error, so every lane must have stopped first.
  const lanes = await Promise.allSettled(Array.from({ length: PARALLEL_CHUNKS }, lane));
  const rejected = lanes.find((l): l is PromiseRejectedResult => l.status === 'rejected');
  if (rejected) throw rejected.reason;
  return total;
}

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

  // ~1 MB writes instead of one per row: a stream write per line dominated small-row seeds (S1-F6).
  const buffered = function* () {
    let buf = '';
    for (const row of fresh) {
      buf += `${row.map(cell).join(',')}\n`;
      if (buf.length >= COPY_BUFFER_CHARS) {
        yield buf;
        buf = '';
      }
    }
    if (buf) yield buf;
  };
  await pipeline(
    Readable.from(buffered()),
    client.query(copyFrom(`copy ${table} (${columns.join(', ')}) from stdin with (format csv)`)),
  );
  return fresh.length;
}
