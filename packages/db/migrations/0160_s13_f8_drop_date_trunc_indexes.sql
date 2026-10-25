-- S13-F8 (S12-F20b): the contract step of S12-F20. The 16 date_trunc keyset indexes are dropped CONCURRENTLY by
-- db:migrate before this migration (DROPPED_INDEXES, concurrent-indexes.ts); these statements are no-ops then.
-- contact notes / contact imports move to raw keyset too: their raw indexes are built CONCURRENTLY (CONCURRENT_INDEXES).
DROP INDEX IF EXISTS "agencies_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "data_export_jobs_agency_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "developments_agency_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "staff_impersonations_agency_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "feed_connections_agency_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "feed_runs_connection_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "listing_bookmarks_folder_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_agency_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_agency_region_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_agency_city_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_agency_location_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_agency_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_agency_country_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_agency_owner_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_agency_updated_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "properties_agency_deleted_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "contact_imports_agency_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "contact_notes_contact_created_idx";--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "contact_imports_agency_created_raw_idx" ON "contact_imports" USING btree ("agency_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "contact_notes_contact_created_raw_idx" ON "contact_notes" USING btree ("agency_id","contact_id","created_at","id");
