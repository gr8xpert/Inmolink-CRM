CREATE TABLE "listing_search_developments" (
	"development_id" uuid PRIMARY KEY NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"ref" text,
	"location_ids" uuid[] NOT NULL,
	"units" integer NOT NULL,
	"available" integer NOT NULL,
	"reserved" integer NOT NULL,
	"price_min_cents" bigint,
	"price_max_cents" bigint,
	"beds_min" integer,
	"beds_max" integer,
	"rep_target_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "listing_search_developments_owner_idx" ON "listing_search_developments" USING btree ("owner_agency_id","development_id");--> statement-breakpoint
CREATE INDEX "listing_search_developments_locations_idx" ON "listing_search_developments" USING gin ("location_ids");--> statement-breakpoint
CREATE INDEX "listing_search_developments_ref_idx" ON "listing_search_developments" USING btree ("owner_agency_id",lower("ref"));--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by `pnpm db:migrate` before this migration (concurrent-indexes.ts): a no-op then
CREATE INDEX IF NOT EXISTS "listing_search_docs_development_ref_idx" ON "listing_search_docs" USING btree ("development_id","ref","target_id") WHERE "listing_search_docs"."development_id" is not null;