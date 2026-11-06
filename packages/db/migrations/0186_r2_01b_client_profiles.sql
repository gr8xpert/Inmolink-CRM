CREATE TABLE "client_profile_embeddings" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"embedding" halfvec(1024) NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_version" integer NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_profile_embeddings_version_ck" CHECK ("client_profile_embeddings"."source_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "client_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"mode" text DEFAULT 'OFF' NOT NULL,
	"frequency" text DEFAULT 'DAILY' NOT NULL,
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
	"wishes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_profiles_mode_ck" CHECK ("client_profiles"."mode" in ('OFF', 'REVIEW', 'AUTO_SEND')),
	CONSTRAINT "client_profiles_frequency_ck" CHECK ("client_profiles"."frequency" in ('INSTANT', 'DAILY', 'WEEKLY')),
	CONSTRAINT "client_profiles_transaction_ck" CHECK ("client_profiles"."transaction_type" is null or "client_profiles"."transaction_type" in ('SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM')),
	CONSTRAINT "client_profiles_arrays_ck" CHECK (cardinality("client_profiles"."property_type_ids") <= 20 and cardinality("client_profiles"."location_ids") <= 20
        and cardinality("client_profiles"."feature_ids") <= 20),
	CONSTRAINT "client_profiles_price_ck" CHECK ("client_profiles"."price_min_cents" is null or "client_profiles"."price_max_cents" is null or "client_profiles"."price_min_cents" <= "client_profiles"."price_max_cents"),
	CONSTRAINT "client_profiles_area_ck" CHECK ("client_profiles"."area_min_m2" is null or "client_profiles"."area_max_m2" is null or "client_profiles"."area_min_m2" <= "client_profiles"."area_max_m2"),
	CONSTRAINT "client_profiles_wishes_ck" CHECK ("client_profiles"."wishes" is null or char_length("client_profiles"."wishes") <= 2000),
	CONSTRAINT "client_profiles_version_ck" CHECK ("client_profiles"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_profile_embeddings_hnsw_idx" ON "client_profile_embeddings" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "client_profile_embeddings_owner_idx" ON "client_profile_embeddings" USING btree ("owner_agency_id","profile_id");--> statement-breakpoint
CREATE INDEX "client_profiles_contact_idx" ON "client_profiles" USING btree ("agency_id","contact_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_profiles_agency_id_uq" ON "client_profiles" USING btree ("agency_id","id");--> statement-breakpoint
-- R2-01b: like listing_embeddings (0185): version touches stay HOT and never re-insert the vector into the graph.
ALTER TABLE "client_profile_embeddings" SET (fillfactor = 80);
