CREATE TABLE "job_checkpoints" (
	"name" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "developments_deleted_idx" ON "developments" USING btree ("deleted_at") WHERE "developments"."deleted_at" is not null;--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "listing_overrides_target_idx" ON "listing_overrides" USING btree ("target_kind","target_id");--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "properties_deleted_idx" ON "properties" USING btree ("deleted_at") WHERE "properties"."deleted_at" is not null;