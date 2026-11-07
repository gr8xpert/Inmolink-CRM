CREATE TABLE "dedupe_listing_signatures" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"signature_version" smallint NOT NULL,
	"transaction_type" text NOT NULL,
	"property_type_id" uuid NOT NULL,
	"city_id" uuid,
	"beds" integer,
	"baths" integer,
	"area_m2" numeric(10, 2),
	"price_cents" bigint,
	"lat" double precision,
	"lng" double precision,
	"image_keys" bigint[] NOT NULL,
	"phashes" bigint[] NOT NULL,
	"block_keys" bigint[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedupe_listing_signatures_version_ck" CHECK ("dedupe_listing_signatures"."source_version" >= 1),
	CONSTRAINT "dedupe_listing_signatures_images_ck" CHECK (cardinality("dedupe_listing_signatures"."image_keys") = cardinality("dedupe_listing_signatures"."phashes") and cardinality("dedupe_listing_signatures"."image_keys") <= 32),
	CONSTRAINT "dedupe_listing_signatures_keys_ck" CHECK (cardinality("dedupe_listing_signatures"."block_keys") <= 256)
);
--> statement-breakpoint
CREATE TABLE "dedupe_pair_scores" (
	"listing_a" uuid NOT NULL,
	"listing_b" uuid NOT NULL,
	"agency_a" uuid NOT NULL,
	"agency_b" uuid NOT NULL,
	"score" real NOT NULL,
	"signals" jsonb NOT NULL,
	"scorer_version" smallint NOT NULL,
	"version_a" integer NOT NULL,
	"version_b" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedupe_pair_scores_pk" PRIMARY KEY("listing_a","listing_b"),
	CONSTRAINT "dedupe_pair_scores_order_ck" CHECK ("dedupe_pair_scores"."listing_a" < "dedupe_pair_scores"."listing_b"),
	CONSTRAINT "dedupe_pair_scores_score_ck" CHECK ("dedupe_pair_scores"."score" >= 0 and "dedupe_pair_scores"."score" <= 1)
);
--> statement-breakpoint
CREATE INDEX "dedupe_listing_signatures_keys_idx" ON "dedupe_listing_signatures" USING gin ("block_keys") WITH (fastupdate=false);--> statement-breakpoint
CREATE INDEX "dedupe_listing_signatures_owner_idx" ON "dedupe_listing_signatures" USING btree ("owner_agency_id","listing_id");--> statement-breakpoint
CREATE INDEX "dedupe_pair_scores_b_idx" ON "dedupe_pair_scores" USING btree ("listing_b");