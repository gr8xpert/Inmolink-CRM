-- migration-check: allow built CONCURRENTLY by `pnpm db:migrate` before this migration (concurrent-indexes.ts): a no-op then
CREATE INDEX IF NOT EXISTS "listing_search_docs_area_f8_idx" ON "listing_search_docs" USING btree (("area_m2"::float8),"target_id");--> statement-breakpoint
-- S7-F11: plot bands compared as float8 get statistics under the table's RLS policy (no index: a plot band is a filter).
-- `listing_search_docs_area_idx` stays for the app version still running during this deploy (dropped by S7-F13).
CREATE STATISTICS IF NOT EXISTS "listing_search_docs_plot_f8_stat" ON (("plot_m2"::float8)) FROM "listing_search_docs";--> statement-breakpoint
-- the expression index's and the statistics object's figures now, not at the next autovacuum analyze (SHARE UPDATE
-- EXCLUSIVE: reads and writes go on)
ANALYZE "listing_search_docs";
