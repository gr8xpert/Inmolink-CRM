ALTER TABLE "listing_read_models" ADD COLUMN "cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "listing_read_models" ADD COLUMN "cluster_rank" smallint;--> statement-breakpoint
ALTER TABLE "listing_search_docs" ADD COLUMN "cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "listing_search_docs" ADD COLUMN "cluster_rank" smallint;--> statement-breakpoint
-- migration-check: allow pre-launch (no production listings yet); later rebuilds run CONCURRENTLY (concurrent-indexes.ts declaredBy)
CREATE INDEX IF NOT EXISTS "listing_read_models_cluster_idx" ON "listing_read_models" USING btree ("cluster_id") WHERE "listing_read_models"."cluster_id" is not null;--> statement-breakpoint
-- migration-check: allow pre-launch (no production listings yet); later rebuilds run CONCURRENTLY (concurrent-indexes.ts declaredBy)
CREATE INDEX IF NOT EXISTS "listing_search_docs_cluster_idx" ON "listing_search_docs" USING btree ("cluster_id","owner_agency_id","cluster_rank") WHERE "listing_search_docs"."cluster_id" is not null;