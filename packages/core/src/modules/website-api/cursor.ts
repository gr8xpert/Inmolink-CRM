import { hmacSha256, safeEqual } from '@inmolink/platform/crypto';
import { AppError } from '@inmolink/platform/errors';
import { cursorSecret } from './settings';

const PURPOSE = 'website-api.search-cursor';
/** Depth is kept in three base-32 digits. */
const MAX_DEPTH = 32 ** 3 - 1;

const macOf = (siteId: string, depth: string, inner: string) =>
  hmacSha256(cursorSecret(), PURPOSE, `${siteId}|${depth}|${inner}`).slice(0, 11);

/**
 * A `/v2/listings` cursor as the site hands it out (S7-04): the search module's cursor behind the page depth it leads
 * to and a MAC over both and the site, so a client can neither reset its depth (honeytokens and the deep-paging rules
 * follow it) nor move a cursor to another site. 14 characters on top of the search cursor (`Cursor` allows 200).
 */
export function wrapSearchCursor(siteId: string, depth: number, inner: string): string {
  const d = Math.min(depth, MAX_DEPTH).toString(32).padStart(3, '0');
  return `${d}${macOf(siteId, d, inner)}${inner}`;
}

/** The depth and inner cursor, or null when the cursor is not this site's (tampered, foreign, issued before S7-04). */
export function readSearchCursor(siteId: string, cursor: string): { depth: number; inner: string } | null {
  const d = cursor.slice(0, 3);
  const inner = cursor.slice(14);
  if (/^[0-9a-v]{3}$/.test(d) && inner !== '' && safeEqual(cursor.slice(3, 14), macOf(siteId, d, inner))) {
    return { depth: Number.parseInt(d, 32), inner };
  }
  return null;
}

export function unwrapSearchCursor(siteId: string, cursor: string): { depth: number; inner: string } {
  const read = readSearchCursor(siteId, cursor);
  if (!read) throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
  return read;
}
