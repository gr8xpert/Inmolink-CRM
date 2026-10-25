CREATE TABLE "matching_listing_states" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"status" text NOT NULL,
	"price_cents" bigint,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_search_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"saved_search_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" integer NOT NULL,
	"ref" text NOT NULL,
	"price_cents" bigint,
	"previous_price_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "saved_search_alerts_kind_ck" CHECK ("saved_search_alerts"."kind" in ('NEW', 'PRICE_DROP', 'BACK_ON_MARKET'))
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'ALL' NOT NULL,
	"frequency" text DEFAULT 'INSTANT' NOT NULL,
	"alert_new" boolean DEFAULT true NOT NULL,
	"alert_price_drop" boolean DEFAULT true NOT NULL,
	"alert_back_on_market" boolean DEFAULT true NOT NULL,
	"transaction_type" text,
	"property_type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"location_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"feature_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"price_min_cents" bigint,
	"price_max_cents" bigint,
	"beds_min" integer,
	"baths_min" integer,
	"area_min_m2" numeric(10, 2),
	"area_max_m2" numeric(10, 2),
	"match_keys" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_searches_name_ck" CHECK (char_length("saved_searches"."name") between 1 and 80),
	CONSTRAINT "saved_searches_scope_ck" CHECK ("saved_searches"."scope" in ('ALL', 'OWN', 'NETWORK')),
	CONSTRAINT "saved_searches_frequency_ck" CHECK ("saved_searches"."frequency" in ('INSTANT', 'DAILY', 'OFF')),
	CONSTRAINT "saved_searches_transaction_ck" CHECK ("saved_searches"."transaction_type" is null or "saved_searches"."transaction_type" in ('SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM')),
	CONSTRAINT "saved_searches_arrays_ck" CHECK (cardinality("saved_searches"."property_type_ids") <= 20 and cardinality("saved_searches"."location_ids") <= 20
        and cardinality("saved_searches"."feature_ids") <= 20 and cardinality("saved_searches"."match_keys") between 1 and 21),
	CONSTRAINT "saved_searches_price_ck" CHECK ("saved_searches"."price_min_cents" is null or "saved_searches"."price_max_cents" is null or "saved_searches"."price_min_cents" <= "saved_searches"."price_max_cents"),
	CONSTRAINT "saved_searches_area_ck" CHECK ("saved_searches"."area_min_m2" is null or "saved_searches"."area_max_m2" is null or "saved_searches"."area_min_m2" <= "saved_searches"."area_max_m2")
);
--> statement-breakpoint
ALTER TABLE "matching_listing_states" ADD CONSTRAINT "matching_listing_states_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_search_alerts" ADD CONSTRAINT "saved_search_alerts_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_search_alerts" ADD CONSTRAINT "saved_search_alerts_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matching_listing_states_agency_idx" ON "matching_listing_states" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "matching_listing_states_gone_idx" ON "matching_listing_states" USING btree ("updated_at") WHERE "matching_listing_states"."status" = 'GONE';--> statement-breakpoint
CREATE UNIQUE INDEX "saved_search_alerts_dedupe_uq" ON "saved_search_alerts" USING btree ("saved_search_id","listing_id","kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "saved_search_alerts_pending_idx" ON "saved_search_alerts" USING btree ("agency_id","saved_search_id","id") WHERE "saved_search_alerts"."notified_at" is null;--> statement-breakpoint
CREATE INDEX "saved_search_alerts_created_idx" ON "saved_search_alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "saved_searches_user_idx" ON "saved_searches" USING btree ("agency_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "saved_searches_match_keys_idx" ON "saved_searches" USING gin ("match_keys") WHERE "saved_searches"."frequency" <> 'OFF';