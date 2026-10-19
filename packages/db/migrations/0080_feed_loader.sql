CREATE TABLE "feed_image_queue" (
	"property_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"urls" text[] NOT NULL,
	"claimed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_image_queue_urls_ck" CHECK (cardinality("feed_image_queue"."urls") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "feed_image_sources" (
	"agency_id" uuid NOT NULL,
	"url_key" char(64) NOT NULL,
	"sha256" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_image_sources_agency_id_url_key_pk" PRIMARY KEY("agency_id","url_key"),
	CONSTRAINT "feed_image_sources_url_key_ck" CHECK ("feed_image_sources"."url_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "feed_image_sources_sha256_ck" CHECK ("feed_image_sources"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "property_import_seen" (
	"agency_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_import_seen_run_id_external_ref_pk" PRIMARY KEY("run_id","external_ref"),
	CONSTRAINT "property_import_seen_ref_ck" CHECK (char_length("property_import_seen"."external_ref") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "property_import_staging" (
	"batch_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"hash" char(64) NOT NULL,
	"images_hash" char(64),
	"held" text[] NOT NULL,
	"status" "listing_status" NOT NULL,
	"transaction_type" "transaction_type" NOT NULL,
	"price_cents" bigint,
	"currency" char(3) NOT NULL,
	"price_period" "price_period",
	"price_on_request" boolean NOT NULL,
	"built_m2" numeric(10, 2),
	"plot_m2" numeric(10, 2),
	"terrace_m2" numeric(10, 2),
	"bedrooms" integer,
	"bathrooms" integer,
	"year_built" integer,
	"energy_rating" "cee_rating",
	"energy_emissions_rating" "cee_rating",
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"exact_lat" numeric(9, 6),
	"exact_lng" numeric(9, 6),
	"location_precision" "location_precision" NOT NULL,
	"property_type_id" uuid,
	"location_id" uuid,
	"country_id" uuid,
	"region_id" uuid,
	"city_id" uuid,
	"feature_ids" uuid[] NOT NULL,
	"translations" jsonb NOT NULL,
	"new_id" uuid NOT NULL,
	"new_ref" text NOT NULL,
	"existing_id" uuid,
	"live" boolean DEFAULT false NOT NULL,
	"old_hash" char(64),
	"old_images_hash" char(64),
	"old_missed" smallint DEFAULT 0 NOT NULL,
	"old_withdrawn" boolean DEFAULT false NOT NULL,
	"old_conn" uuid,
	CONSTRAINT "property_import_staging_batch_id_ref_pk" PRIMARY KEY("batch_id","ref")
);
--> statement-breakpoint
ALTER TABLE "feed_runs" ADD COLUMN "items_held" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_runs" ADD COLUMN "items_withdrawn" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "property_privates" ADD COLUMN "import_hash" char(64);--> statement-breakpoint
ALTER TABLE "property_privates" ADD COLUMN "import_images_hash" char(64);--> statement-breakpoint
ALTER TABLE "property_privates" ADD COLUMN "import_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "property_privates" ADD COLUMN "import_missed_runs" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "property_privates" ADD COLUMN "import_withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "property_privates" ADD COLUMN "import_held" text[];--> statement-breakpoint
ALTER TABLE "feed_image_queue" ADD CONSTRAINT "feed_image_queue_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_image_sources" ADD CONSTRAINT "feed_image_sources_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_import_seen" ADD CONSTRAINT "property_import_seen_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_image_queue_agency_created_idx" ON "feed_image_queue" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX "feed_image_queue_updated_idx" ON "feed_image_queue" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "property_import_seen_agency_created_idx" ON "property_import_seen" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE INDEX "property_import_seen_created_idx" ON "property_import_seen" USING btree ("created_at");--> statement-breakpoint
-- migration-check: allow pre-launch: property_privates is small until imports fill it (S6-02); its columns are new here,
-- so db:migrate cannot build it CONCURRENTLY first (concurrent-indexes.ts, declaredBy) — later rebuilds are concurrent
CREATE INDEX IF NOT EXISTS "property_privates_import_connection_idx" ON "property_privates" USING btree ("agency_id","import_connection_id","external_ref") WHERE "property_privates"."import_connection_id" is not null;--> statement-breakpoint
-- NOT VALID: existing rows have the new columns' null/0 (they satisfy both); validating would scan the large table
-- under the migration's ACCESS EXCLUSIVE lock. Enforced for every insert and update from now on.
ALTER TABLE "property_privates" ADD CONSTRAINT "property_privates_import_missed_ck" CHECK ("property_privates"."import_missed_runs" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "property_privates" ADD CONSTRAINT "property_privates_import_hash_ck" CHECK (("property_privates"."import_hash" is null or "property_privates"."import_hash" ~ '^[0-9a-f]{64}$')
        and ("property_privates"."import_images_hash" is null or "property_privates"."import_images_hash" ~ '^[0-9a-f]{64}$')) NOT VALID;--> statement-breakpoint
-- S6-02: staging rows live and die inside one batch transaction; nothing to WAL-log or recover after a crash.
ALTER TABLE "property_import_staging" SET UNLOGGED;--> statement-breakpoint
-- Every batch inserts and deletes its rows in one transaction: vacuum the dead ones often, not at 20 % of a table
-- that never holds live rows.
ALTER TABLE "property_import_staging" SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 5000);
