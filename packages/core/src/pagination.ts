import { AppError } from '@inmolink/platform/errors';
import { type AnyColumn, and, asc, desc, eq, gt, lt, or, type SQL, sql } from 'drizzle-orm';

/**
 * Keyset cursors for list endpoints (PATTERNS §5): the last row's sort key, `(created_at, id)`, as
 * opaque base64url. A cursor that does not decode is the caller's error, never a full scan.
 */
export interface KeysetCursor {
  at: Date;
  id: string;
}

export function encodeCursor(c: KeysetCursor): string {
  return Buffer.from(JSON.stringify([c.at.toISOString(), c.id])).toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(cursor: string | undefined): KeysetCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    const date = typeof at === 'string' ? new Date(at) : new Date(Number.NaN);
    if (typeof id === 'string' && UUID.test(id) && !Number.isNaN(date.getTime())) return { at: date, id };
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

/** `WHERE` part of a keyset page after `cursor` (none on the first page). */
export function keysetAfter(
  at: AnyColumn,
  id: AnyColumn,
  cursor: KeysetCursor | undefined,
  dir: 'asc' | 'desc',
): SQL | undefined {
  if (!cursor) return undefined;
  const t = keysetTime(at);
  const after = dir === 'asc' ? gt : lt;
  return or(after(t, cursor.at), and(eq(t, cursor.at), after(id, cursor.id)));
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
