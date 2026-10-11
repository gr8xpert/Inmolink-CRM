/**
 * billing queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/billing` — other modules' tables fail `pnpm check:boundaries`.
 */
