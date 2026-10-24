import { type AnyColumn, desc, type SQL, sql } from 'drizzle-orm';
import type { KeysetCursor } from '../../pagination';

/**
 * crm's keyset (S10-02 review): newest first on a stored millisecond column (`created_ms`) and the id, the cursor as
 * one row comparison `(created_ms, id) < (?, ?)`. Both make it an index condition under RLS: the shared helper's
 * `date_trunc(…) < ? or (date_trunc(…) = ? and id < ?)` is an `or` (never an index condition) over a function that is
 * not leakproof (kept out of index conditions under RLS), so a deep page read the agency's whole index range.
 */
export function rowAfter(ms: AnyColumn, id: AnyColumn, cursor: KeysetCursor | undefined): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${ms}, ${id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
}

/** `ORDER BY` of a crm list: the stored millisecond time, then the id, newest first. */
export function rowOrder(ms: AnyColumn, id: AnyColumn): SQL[] {
  return [desc(ms), desc(id)];
}
