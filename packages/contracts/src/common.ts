import { z } from 'zod';

/** Shared building blocks for list endpoints (PATTERNS §9). */

/** Opaque keyset cursor from a previous page's `nextCursor` (base64url). Clients never build one. */
export const Cursor = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

/** `?cursor=&limit=`: keyset pagination, at most 100 per page (CLAUDE.md budgets). */
export const PageQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** A page of `item`; `nextCursor` is null on the last page. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: Cursor.nullable() });
}

/** ISO 4217 currency code (`EUR`). */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 code such as EUR');
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** Money on the wire (`.claude/rules/api.md`): integer cents plus currency. */
export const Money = z.object({ amountCents: z.number().int(), currency: CurrencyCode });
export type Money = z.infer<typeof Money>;
