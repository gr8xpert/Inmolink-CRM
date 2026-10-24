import { AppError } from '@inmolink/platform/errors';
import { type AnyColumn, and, asc, desc, eq, gt, lt, or, type SQL, sql } from 'drizzle-orm';

/**
 * Keyset cursors for list endpoints (PATTERNS §5): the last row's sort key, `(created_at, id)`, as
 * opaque base64url. A cursor that does not decode is the caller's error, never a full scan.
 */
export interface KeysetCursor {
  at: Date;
  id: string;
  /**
   * The sort time with its microseconds (`keysetStamp`), for lists ordered on the raw column (`keysetAfterRaw`):
   * `at` (a JS `Date`) only holds milliseconds.
   */
  atUs?: string;
}

export function encodeCursor(c: KeysetCursor): string {
  const parts = c.atUs === undefined ? [c.at.toISOString(), c.id] : [c.at.toISOString(), c.id, c.atUs];
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A microsecond stamp that is a real instant (no month 13, no Feb 30) and agrees with the cursor's time to the ms. */
function validStamp(us: string, at: Date): boolean {
  if (!STAMP.test(us)) return false;
  const d = new Date(us);
  return !Number.isNaN(d.getTime()) && `${us.slice(0, 23)}Z` === d.toISOString() && d.getTime() === at.getTime();
}

export function decodeCursor(cursor: string | undefined): KeysetCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parts) && parts.length >= 2 && parts.length <= 3) {
      const [at, id, us] = parts as unknown[];
      const date = typeof at === 'string' ? new Date(at) : new Date(Number.NaN);
      if (typeof id === 'string' && UUID.test(id) && !Number.isNaN(date.getTime())) {
        if (parts.length === 2) return { at: date, id };
        if (typeof us === 'string' && validStamp(us, date)) return { at: date, id, atUs: us };
      }
    }
  } catch {
    // falls through to the error below
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

/**
 * The sort time as the cursor can hold it. Postgres keeps microseconds, a cursor (JS `Date`) only
 * milliseconds: comparing the raw column with a cursor skips rows (newest first) or repeats them (oldest
 * first) when timestamps share a millisecond. Lists order and compare on the millisecond-truncated time,
 * then the id (S1-09 review, PATTERNS §5). The three-argument form is IMMUTABLE (the two-argument one on
 * `timestamptz` is only STABLE), so an index on `(…, date_trunc('milliseconds', col, 'UTC'), id)` serves
 * the order without a sort (S2-F1). Tables written with millisecond times (`audit_logs`) may use the raw
 * column and keep their index order.
 */
export function keysetTime(at: AnyColumn): SQL {
  return sql`date_trunc('milliseconds', ${at}, 'UTC')`;
}

/**
 * `WHERE` part of a keyset page after `cursor` (none on the first page) on the millisecond-truncated time
 * (`date_trunc`, matching the `(…, date_trunc(time), id)` indexes): a row comparison `(time, id) > (?, ?)` where
 * time and id share a direction, the `or` form for mixed directions (`idDir`). `date_trunc` is not leakproof, so
 * under RLS either form is a Filter, not an Index Cond; lists on raw-column indexes use `keysetAfterRaw` (S11-F9).
 */
export function keysetAfter(
  at: AnyColumn,
  id: AnyColumn,
  cursor: KeysetCursor | undefined,
  dir: 'asc' | 'desc',
  idDir: 'asc' | 'desc' = dir,
): SQL | undefined {
  if (!cursor) return undefined;
  const t = keysetTime(at);
  if (idDir === dir) {
    const op = dir === 'asc' ? sql`>` : sql`<`;
    return sql`(${t}, ${id}) ${op} (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
  }
  const after = dir === 'asc' ? gt : lt;
  const idAfter = idDir === 'asc' ? gt : lt;
  return or(after(t, cursor.at), and(eq(t, cursor.at), idAfter(id, cursor.id)));
}

/**
 * A sort time as text with its microseconds, selected next to the row so its cursor can hold the exact time
 * (`KeysetCursor.atUs`) for `keysetAfterRaw`.
 */
export function keysetStamp(at: AnyColumn): SQL<string> {
  return sql<string>`to_char(${at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Keyset page after `cursor` on the RAW sort column (S11-F9): `(col, id) > (?, ?)` compares only leakproof
 * operators (`timestamptz`, `uuid`), so under RLS it is an index condition on a plain `(…, col, id)` index,
 * where the millisecond form of `keysetAfter` (a `date_trunc` over the column, not leakproof) stays a filter.
 * The cursor must carry `atUs` (a cursor from before this change does not: VALIDATION_FAILED, the client restarts).
 */
export function keysetAfterRaw(
  at: AnyColumn,
  id: AnyColumn,
  cursor: KeysetCursor | undefined,
  dir: 'asc' | 'desc',
): SQL | undefined {
  if (!cursor) return undefined;
  if (cursor.atUs === undefined) throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
  const op = dir === 'asc' ? sql`>` : sql`<`;
  return sql`(${at}, ${id}) ${op} (${cursor.atUs}::timestamptz, ${cursor.id}::uuid)`;
}

/** `ORDER BY` matching `keysetAfterRaw`: the raw time, then the id, both in `dir`. */
export function keysetOrderRaw(at: AnyColumn, id: AnyColumn, dir: 'asc' | 'desc'): SQL[] {
  const by = dir === 'asc' ? asc : desc;
  return [by(at), by(id)];
}

/** `ORDER BY` of a keyset list: truncated time, then id, both in `dir`. */
export function keysetOrder(at: AnyColumn, id: AnyColumn, dir: 'asc' | 'desc'): SQL[] {
  const by = dir === 'asc' ? asc : desc;
  return [by(keysetTime(at)), by(id)];
}

/** `limit + 1` rows in, one page out. */
export function toPage<R, T>(
  rows: R[],
  limit: number,
  key: (row: R) => KeysetCursor,
  map: (row: R) => T,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(map), nextCursor: rows.length > limit && last ? encodeCursor(key(last)) : null };
}
