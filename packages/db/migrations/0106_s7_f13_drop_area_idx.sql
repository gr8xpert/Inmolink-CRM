-- The index of the app version before S7-F11 (area bands on the numeric column). `pnpm db:migrate` dropped it
-- CONCURRENTLY, outside this transaction (DROPPED_INDEXES, concurrent-indexes.ts); this statement is a no-op then.
DROP INDEX IF EXISTS "listing_search_docs_area_idx";
