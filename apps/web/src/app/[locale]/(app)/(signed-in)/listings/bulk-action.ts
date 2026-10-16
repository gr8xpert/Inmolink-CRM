import type { ListingBulkAction } from '@inmolink/contracts';
import { isOneOf, LISTING_STATUSES, normalizeListingTag, SHARE_SCOPES, VISIBILITIES } from '@inmolink/contracts/values';

/** The bulk bar's action (S3-07): its type and the one value it takes, as the API wants it. */
export type ActionType = ListingBulkAction['type'];
export const ACTION_TYPES: ActionType[] = ['STATUS', 'VISIBILITY', 'SHARE_SCOPE', 'PRICE_CHANGE', 'ASSIGN', 'ADD_TAG'];

/** The action the bar's fields describe, or null while incomplete. */
export function bulkActionOf(type: ActionType, value: string): ListingBulkAction | null {
  const v = value.trim();
  if (!v) return null;
  switch (type) {
    case 'STATUS':
      return isOneOf(LISTING_STATUSES, v) ? { type, status: v } : null;
    case 'VISIBILITY':
      return isOneOf(VISIBILITIES, v) ? { type, visibility: v } : null;
    case 'SHARE_SCOPE':
      return isOneOf(SHARE_SCOPES, v) ? { type, shareScope: v } : null;
    case 'PRICE_CHANGE': {
      // a percentage with up to two decimals → basis points
      const pct = Number(v.replace(',', '.'));
      const percentBp = Math.round(pct * 100);
      return Number.isFinite(pct) && percentBp !== 0 && percentBp >= -9_000 && percentBp <= 10_000
        ? { type, percentBp }
        : null;
    }
    case 'ASSIGN':
      return { type, ownerUserId: v };
    case 'ADD_TAG': {
      const tag = normalizeListingTag(v);
      return tag ? { type, tag } : null;
    }
  }
}
