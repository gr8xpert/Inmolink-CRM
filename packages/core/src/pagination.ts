import { AppError } from '@inmolink/platform/errors';

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
