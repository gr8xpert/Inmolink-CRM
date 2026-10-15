import { type ListingBulkAction, ListingStatus, ListingTag, ShareScope, Visibility } from '@inmolink/contracts';

/** The bulk bar's action (S3-07): its type and the one value it takes, as the API wants it. */
export type ActionType = ListingBulkAction['type'];
export const ACTION_TYPES: ActionType[] = ['STATUS', 'VISIBILITY', 'SHARE_SCOPE', 'PRICE_CHANGE', 'ASSIGN', 'ADD_TAG'];

/** The action the bar's fields describe, or null while incomplete. */
export function bulkActionOf(type: ActionType, value: string): ListingBulkAction | null {
  const v = value.trim();
  if (!v) return null;
  switch (type) {
    case 'STATUS':
      return ListingStatus.safeParse(v).success ? { type, status: v as ListingStatus } : null;
    case 'VISIBILITY':
      return Visibility.safeParse(v).success ? { type, visibility: v as Visibility } : null;
    case 'SHARE_SCOPE':
      return ShareScope.safeParse(v).success ? { type, shareScope: v as ShareScope } : null;
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
      const tag = ListingTag.safeParse(v);
      return tag.success ? { type, tag: tag.data } : null;
    }
  }
}
