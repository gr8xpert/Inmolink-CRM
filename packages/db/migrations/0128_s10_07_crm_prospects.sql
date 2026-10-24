CREATE TABLE "seller_prospects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid,
	"title" text NOT NULL,
	"address" text,
	"area" text,
	"property_type_id" uuid,
	"location_id" uuid,
	"estimated_price_cents" bigint,
	"currency" char(3),
	"stage" text DEFAULT 'NEW' NOT NULL,
	"stage_rank" text COLLATE "C" NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_follow_up_at" timestamp with time zone,
	"assigned_user_id" uuid,
	"confidential_notes" text,
	"listing_id" uuid,
	"converted_at" timestamp with time zone,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"idempotency_hash" text,
	"request_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_ms" timestamp with time zone GENERATED ALWAYS AS (date_trunc('milliseconds', created_at, 'UTC')) STORED NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_prospects_stage_ck" CHECK ("seller_prospects"."stage" in ('NEW', 'CONTACTED', 'VALUATION', 'NEGOTIATION', 'MANDATE', 'LISTED', 'LOST')),
	CONSTRAINT "seller_prospects_stage_rank_ck" CHECK ("seller_prospects"."stage_rank" ~ '^[0-9a-z]*[1-9a-z]$' and length("seller_prospects"."stage_rank") <= 200),
	CONSTRAINT "seller_prospects_title_ck" CHECK (length("seller_prospects"."title") between 1 and 200),
	CONSTRAINT "seller_prospects_address_ck" CHECK ("seller_prospects"."address" is null or length("seller_prospects"."address") between 1 and 300),
	CONSTRAINT "seller_prospects_area_ck" CHECK ("seller_prospects"."area" is null or length("seller_prospects"."area") between 1 and 120),
	CONSTRAINT "seller_prospects_notes_ck" CHECK ("seller_prospects"."confidential_notes" is null or length("seller_prospects"."confidential_notes") between 1 and 4000),
	CONSTRAINT "seller_prospects_price_ck" CHECK ("seller_prospects"."estimated_price_cents" is null or "seller_prospects"."estimated_price_cents" between 0 and 100000000000000),
	CONSTRAINT "seller_prospects_currency_ck" CHECK (("seller_prospects"."estimated_price_cents" is null) = ("seller_prospects"."currency" is null) and ("seller_prospects"."currency" is null or "seller_prospects"."currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "seller_prospects_follow_up_ms_ck" CHECK ("seller_prospects"."next_follow_up_at" is null or "seller_prospects"."next_follow_up_at" = date_trunc('milliseconds', "seller_prospects"."next_follow_up_at", 'UTC')),
	CONSTRAINT "seller_prospects_converted_ck" CHECK ("seller_prospects"."listing_id" is null or "seller_prospects"."converted_at" is not null),
	CONSTRAINT "seller_prospects_idempotency_ck" CHECK (("seller_prospects"."idempotency_hash" is null) = ("seller_prospects"."request_hash" is null))
);
--> statement-breakpoint
ALTER TABLE "seller_prospects" ADD CONSTRAINT "seller_prospects_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_prospects" ADD CONSTRAINT "seller_prospects_contact_fk" FOREIGN KEY ("agency_id","contact_id") REFERENCES "public"."contacts"("agency_id","id") ON DELETE SET NULL ("contact_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_prospects_board_idx" ON "seller_prospects" USING btree ("agency_id","stage","stage_rank","id") WHERE "seller_prospects"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "seller_prospects_created_idx" ON "seller_prospects" USING btree ("agency_id","created_ms","id") WHERE "seller_prospects"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "seller_prospects_stage_created_idx" ON "seller_prospects" USING btree ("agency_id","stage","created_ms","id") WHERE "seller_prospects"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "seller_prospects_follow_up_idx" ON "seller_prospects" USING btree ("agency_id","next_follow_up_at","id") WHERE "seller_prospects"."next_follow_up_at" is not null and "seller_prospects"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "seller_prospects_contact_idx" ON "seller_prospects" USING btree ("agency_id","contact_id") WHERE "seller_prospects"."contact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_prospects_listing_uq" ON "seller_prospects" USING btree ("agency_id","listing_id") WHERE "seller_prospects"."listing_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_prospects_idempotency_uq" ON "seller_prospects" USING btree ("agency_id","idempotency_hash") WHERE "seller_prospects"."idempotency_hash" is not null;--> statement-breakpoint
-- migration-check: allow built CONCURRENTLY by db:migrate before this migration (concurrent-indexes.ts); a no-op then
CREATE INDEX IF NOT EXISTS "property_privates_seller_idx" ON "property_privates" USING btree ("agency_id","seller_contact_id") WHERE "property_privates"."seller_contact_id" is not null;