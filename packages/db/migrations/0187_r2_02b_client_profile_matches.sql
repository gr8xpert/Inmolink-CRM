CREATE TABLE "client_profile_matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"listing_agency_id" uuid NOT NULL,
	"listing_version" integer NOT NULL,
	"profile_version" integer NOT NULL,
	"hard_score" real NOT NULL,
	"semantic_score" real,
	"boost_score" real DEFAULT 0 NOT NULL,
	"total_score" real NOT NULL,
	"explanation" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_profile_matches_status_ck" CHECK ("client_profile_matches"."status" in ('PENDING_REVIEW', 'QUEUED', 'SENT', 'DISMISSED', 'EXPIRED')),
	CONSTRAINT "client_profile_matches_scores_ck" CHECK ("client_profile_matches"."hard_score" between 0 and 1 and ("client_profile_matches"."semantic_score" is null or "client_profile_matches"."semantic_score" between 0 and 1))
);
--> statement-breakpoint
CREATE TABLE "matching_listing_facts" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"transaction_type" text NOT NULL,
	"property_type_id" uuid NOT NULL,
	"location_ids" uuid[] NOT NULL,
	"feature_ids" uuid[] NOT NULL,
	"price_cents" bigint,
	"beds" integer,
	"baths" integer,
	"area_m2" numeric(10, 2),
	"share_scope" text NOT NULL,
	"preferred_agency_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"match_keys" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matching_listing_facts_share_ck" CHECK ("matching_listing_facts"."share_scope" in ('ALL', 'PREFERRED')),
	CONSTRAINT "matching_listing_facts_version_ck" CHECK ("matching_listing_facts"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "client_profiles" ADD COLUMN "match_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "client_profile_matches" ADD CONSTRAINT "client_profile_matches_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_profile_matches" ADD CONSTRAINT "client_profile_matches_profile_id_client_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."client_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_listing_facts" ADD CONSTRAINT "matching_listing_facts_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_profile_matches_pair_uq" ON "client_profile_matches" USING btree ("profile_id","listing_id");--> statement-breakpoint
CREATE INDEX "client_profile_matches_queue_idx" ON "client_profile_matches" USING btree ("agency_id","profile_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "client_profile_matches_agency_status_idx" ON "client_profile_matches" USING btree ("agency_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "matching_listing_facts_match_keys_idx" ON "matching_listing_facts" USING gin ("match_keys");--> statement-breakpoint
CREATE INDEX "matching_listing_facts_agency_idx" ON "matching_listing_facts" USING btree ("agency_id","listing_id");--> statement-breakpoint
CREATE INDEX "matching_listing_facts_updated_idx" ON "matching_listing_facts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "client_profiles_match_keys_idx" ON "client_profiles" USING gin ("match_keys") WHERE "client_profiles"."mode" <> 'OFF';