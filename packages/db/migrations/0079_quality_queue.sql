CREATE TABLE "quality_queue" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rechecks" integer DEFAULT 0 NOT NULL,
	"claimed_until" timestamp with time zone,
	"claim_token" uuid
);
--> statement-breakpoint
CREATE INDEX "quality_queue_agency_due_idx" ON "quality_queue" USING btree ("owner_agency_id","due_at");--> statement-breakpoint
CREATE INDEX "quality_queue_due_idx" ON "quality_queue" USING btree ("due_at");
--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts, S6-F3); 0069 created it, so a no-op
CREATE INDEX IF NOT EXISTS "properties_agency_network_idx" ON "properties" USING btree ("agency_id") WHERE "properties"."visibility" <> 'PRIVATE' and "properties"."status" = 'ACTIVE' and "properties"."deleted_at" is null and "properties"."network_hidden_at" is null;