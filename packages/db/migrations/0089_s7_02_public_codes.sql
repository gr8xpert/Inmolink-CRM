CREATE TABLE "listing_public_codes" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_public_codes_code_ck" CHECK ("listing_public_codes"."code" ~ '^[0-9A-HJKMNP-TV-Z]{8}$')
);
--> statement-breakpoint
ALTER TABLE "listing_search_docs" ADD COLUMN "public_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_public_codes_code_uq" ON "listing_public_codes" USING btree ("code");--> statement-breakpoint
-- migration-check: allow pre-launch: listing_search_docs has no production rows yet (no servers before H3/H4); the column is new, so it cannot be built CONCURRENTLY before this migration
CREATE INDEX "listing_search_docs_public_code_idx" ON "listing_search_docs" USING btree ("public_code") WHERE "listing_search_docs"."public_code" is not null;