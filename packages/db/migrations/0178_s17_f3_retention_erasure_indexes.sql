-- S17-F3: the daily retention scan's keyset (contacts by updated_at) and agency erasure's text sweep over deleted tasks
-- and prospects. Large tables: built CONCURRENTLY by db:migrate first (CONCURRENT_INDEXES); here a no-op then, and the
-- build on a fresh database (empty tables).
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "contacts_retention_idx" ON "contacts" USING btree ("agency_id","updated_at","id") WHERE "contacts"."deleted_at" is null;--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "seller_prospects_agency_deleted_idx" ON "seller_prospects" USING btree ("agency_id","id") WHERE "seller_prospects"."deleted_at" is not null;--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "tasks_agency_deleted_idx" ON "tasks" USING btree ("agency_id","id") WHERE "tasks"."deleted_at" is not null;
