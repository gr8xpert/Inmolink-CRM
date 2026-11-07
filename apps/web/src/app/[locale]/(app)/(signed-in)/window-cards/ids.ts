import { WINDOW_CARDS_MAX } from '@inmolink/contracts';
import { z } from 'zod';

const Ids = z
  .array(z.uuid())
  .min(1)
  .max(WINDOW_CARDS_MAX)
  .refine((ids) => new Set(ids).size === ids.length);

/** The listing ids of `?listingIds=` (comma-separated, the listings table hands its picks over here); [] when invalid. */
export function listingIdsOf(raw: string | undefined): string[] {
  const ids = (raw ?? '').split(',').filter(Boolean);
  return Ids.safeParse(ids).success ? ids : [];
}
