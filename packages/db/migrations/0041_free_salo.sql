CREATE TYPE "public"."cee_rating" AS ENUM('A', 'B', 'C', 'D', 'E', 'F', 'G', 'EXEMPT', 'PENDING');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('DRAFT', 'ACTIVE', 'UNDER_OFFER', 'SOLD', 'RENTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."location_precision" AS ENUM('EXACT', 'APPROX');--> statement-breakpoint
CREATE TYPE "public"."price_period" AS ENUM('NIGHT', 'WEEK', 'MONTH');--> statement-breakpoint
CREATE TYPE "public"."property_media_kind" AS ENUM('IMAGE', 'FLOOR_PLAN', 'VIDEO', 'DOCUMENT');--> statement-breakpoint
CREATE TYPE "public"."share_scope" AS ENUM('ALL', 'PREFERRED');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM');--> statement-breakpoint
CREATE TYPE "public"."translation_origin" AS ENUM('HUMAN', 'AI_DRAFT', 'REVIEWED');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('PRIVATE', 'SHARED', 'PUBLIC');--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"external_ref" text,
	"legacy_id" text,
	"status" "listing_status" DEFAULT 'DRAFT' NOT NULL,
	"visibility" "visibility" DEFAULT 'PRIVATE' NOT NULL,
	"share_scope" "share_scope" DEFAULT 'ALL' NOT NULL,
	"transaction_type" "transaction_type" DEFAULT 'SALE' NOT NULL,
	"price_cents" bigint,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"price_period" "price_period",
	"price_on_request" boolean DEFAULT false NOT NULL,
	"commission_bp" integer,
	"commission_fixed_cents" bigint,
	"split_bp" integer,
	"commission_includes_vat" boolean DEFAULT false NOT NULL,
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
	"location_precision" "location_precision" DEFAULT 'APPROX' NOT NULL,
	"property_type_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"development_id" uuid,
	"unit_id" uuid,
	"duplicate_cluster_id" uuid,
	"is_canonical" boolean DEFAULT true NOT NULL,
	"quality_score" integer,
	"last_confirmed_at" timestamp with time zone,
	"locked_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "properties_id_agency_uq" UNIQUE("id","agency_id"),
	CONSTRAINT "properties_currency_ck" CHECK ("properties"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "properties_price_ck" CHECK ("properties"."price_cents" is null or "properties"."price_cents" >= 0),
	CONSTRAINT "properties_price_period_ck" CHECK ("properties"."price_period" is null or "properties"."transaction_type" <> 'SALE'),
	CONSTRAINT "properties_commission_ck" CHECK (("properties"."commission_bp" is null or "properties"."commission_bp" between 1 and 10000)
        and ("properties"."commission_fixed_cents" is null or "properties"."commission_fixed_cents" between 1 and 100000000000)
        and not ("properties"."commission_bp" is not null and "properties"."commission_fixed_cents" is not null)),
	CONSTRAINT "properties_split_ck" CHECK ("properties"."split_bp" is null or "properties"."split_bp" between 0 and 10000),
	CONSTRAINT "properties_specs_ck" CHECK (("properties"."bedrooms" is null or "properties"."bedrooms" between 0 and 1000)
        and ("properties"."bathrooms" is null or "properties"."bathrooms" between 0 and 1000)
        and ("properties"."year_built" is null or "properties"."year_built" between 1000 and 3000)
        and ("properties"."built_m2" is null or "properties"."built_m2" >= 0)
        and ("properties"."plot_m2" is null or "properties"."plot_m2" >= 0)
        and ("properties"."terrace_m2" is null or "properties"."terrace_m2" >= 0)),
	CONSTRAINT "properties_coordinates_ck" CHECK (("properties"."lat" is null) = ("properties"."lng" is null)
        and ("properties"."lat" is null or ("properties"."lat" between -90 and 90 and "properties"."lng" between -180 and 180))),
	CONSTRAINT "properties_quality_ck" CHECK ("properties"."quality_score" is null or "properties"."quality_score" between 0 and 100),
	CONSTRAINT "properties_version_ck" CHECK ("properties"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "property_features" (
	"property_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_features_property_id_feature_id_pk" PRIMARY KEY("property_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "property_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"media_object_id" uuid NOT NULL,
	"kind" "property_media_kind" DEFAULT 'IMAGE' NOT NULL,
	"position" integer NOT NULL,
	"is_cover" boolean DEFAULT false NOT NULL,
	"alt_text" text,
	"room_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_media_position_ck" CHECK ("property_media"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "property_price_histories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"previous_price_cents" bigint,
	"price_cents" bigint,
	"currency" char(3) NOT NULL,
	"changed_by_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_price_histories_currency_ck" CHECK ("property_price_histories"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "property_privates" (
	"property_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"cadastral_ref" text,
	"seller_contact_id" uuid,
	"internal_notes" text,
	"keys_info" text,
	"exact_lat" numeric(9, 6),
	"exact_lng" numeric(9, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_privates_coordinates_ck" CHECK (("property_privates"."exact_lat" is null) = ("property_privates"."exact_lng" is null)
        and ("property_privates"."exact_lat" is null or ("property_privates"."exact_lat" between -90 and 90 and "property_privates"."exact_lng" between -180 and 180)))
);
--> statement-breakpoint
CREATE TABLE "property_status_histories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"from_status" "listing_status",
	"to_status" "listing_status" NOT NULL,
	"changed_by_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_translations" (
	"property_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"slug" text NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"origin" "translation_origin" DEFAULT 'HUMAN' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_translations_property_id_locale_pk" PRIMARY KEY("property_id","locale"),
	CONSTRAINT "property_translations_locale_ck" CHECK ("property_translations"."locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
	CONSTRAINT "property_translations_slug_ck" CHECK ("property_translations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_property_type_id_property_types_id_fk" FOREIGN KEY ("property_type_id") REFERENCES "public"."property_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_owner_member_fk" FOREIGN KEY ("agency_id","owner_user_id") REFERENCES "public"."agency_members"("agency_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_features" ADD CONSTRAINT "property_features_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_features" ADD CONSTRAINT "property_features_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_price_histories" ADD CONSTRAINT "property_price_histories_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_privates" ADD CONSTRAINT "property_privates_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_status_histories" ADD CONSTRAINT "property_status_histories_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_translations" ADD CONSTRAINT "property_translations_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "properties_agency_ref_uq" ON "properties" USING btree ("agency_id","ref");--> statement-breakpoint
CREATE INDEX "properties_agency_created_idx" ON "properties" USING btree ("agency_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE INDEX "properties_agency_owner_idx" ON "properties" USING btree ("agency_id","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_source_ref_uq" ON "properties" USING btree ("agency_id","source","external_ref") WHERE "properties"."external_ref" is not null;--> statement-breakpoint
CREATE INDEX "properties_agency_legacy_idx" ON "properties" USING btree ("agency_id","legacy_id") WHERE "properties"."legacy_id" is not null;--> statement-breakpoint
CREATE INDEX "properties_location_type_idx" ON "properties" USING btree ("location_id","property_type_id","price_cents");--> statement-breakpoint
CREATE INDEX "properties_property_type_idx" ON "properties" USING btree ("property_type_id");--> statement-breakpoint
CREATE INDEX "properties_duplicate_cluster_idx" ON "properties" USING btree ("duplicate_cluster_id") WHERE "properties"."duplicate_cluster_id" is not null;--> statement-breakpoint
CREATE INDEX "property_features_feature_idx" ON "property_features" USING btree ("feature_id");--> statement-breakpoint
CREATE INDEX "property_media_property_idx" ON "property_media" USING btree ("property_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "property_media_cover_uq" ON "property_media" USING btree ("property_id") WHERE "property_media"."is_cover";--> statement-breakpoint
CREATE INDEX "property_media_object_idx" ON "property_media" USING btree ("media_object_id");--> statement-breakpoint
CREATE INDEX "property_price_histories_property_idx" ON "property_price_histories" USING btree ("property_id","changed_at","id");--> statement-breakpoint
CREATE INDEX "property_status_histories_property_idx" ON "property_status_histories" USING btree ("property_id","changed_at","id");