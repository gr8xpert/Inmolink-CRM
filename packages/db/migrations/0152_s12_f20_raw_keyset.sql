-- S12-F20: raw keyset indexes (the expand step). The date_trunc ones stay for the app version still running
-- during this deploy; S12-F20b drops them concurrently (DROPPED_INDEXES, after this migration).
DROP INDEX "feed_mapping_profiles_agency_created_idx";--> statement-breakpoint
CREATE INDEX "agencies_created_raw_idx" ON "agencies" USING btree ("created_at","agency_id");--> statement-breakpoint
CREATE INDEX "data_export_jobs_agency_created_raw_idx" ON "data_export_jobs" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "developments_agency_created_raw_idx" ON "developments" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE INDEX "staff_impersonations_agency_raw_idx" ON "staff_impersonations" USING btree ("agency_id","started_at","id");--> statement-breakpoint
CREATE INDEX "feed_connections_agency_created_raw_idx" ON "feed_connections" USING btree ("agency_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "feed_runs_connection_created_raw_idx" ON "feed_runs" USING btree ("connection_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "listing_bookmarks_folder_created_raw_idx" ON "listing_bookmarks" USING btree ("agency_id","folder_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_created_raw_idx" ON "properties" USING btree ("agency_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_region_raw_idx" ON "properties" USING btree ("agency_id","region_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_city_raw_idx" ON "properties" USING btree ("agency_id","city_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_location_raw_idx" ON "properties" USING btree ("agency_id","location_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_status_raw_idx" ON "properties" USING btree ("agency_id","status_code","created_at","id") WHERE "properties"."deleted_at" is null;--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_country_raw_idx" ON "properties" USING btree ("agency_id","country_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_owner_raw_idx" ON "properties" USING btree ("agency_id","owner_user_id","created_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_updated_raw_idx" ON "properties" USING btree ("agency_id","updated_at","id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_agency_deleted_raw_idx" ON "properties" USING btree ("agency_id","created_at","id") WHERE "properties"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "feed_mapping_profiles_agency_created_idx" ON "feed_mapping_profiles" USING btree ("agency_id","created_at","id");