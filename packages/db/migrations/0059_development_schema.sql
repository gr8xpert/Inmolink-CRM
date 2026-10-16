CREATE TYPE "public"."development_access_kind" AS ENUM('OPEN', 'PRIVATE_NETWORK');--> statement-breakpoint
CREATE TYPE "public"."development_document_kind" AS ENUM('BROCHURE', 'PRICE_LIST', 'FLOOR_PLAN', 'SPECIFICATIONS', 'PAYMENT_PLAN', 'LEGAL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."development_manager" AS ENUM('DEVELOPER', 'DATA_OPS');--> statement-breakpoint
CREATE TYPE "public"."development_status" AS ENUM('OFF_PLAN', 'UNDER_CONSTRUCTION', 'KEY_READY', 'SOLD_OUT');--> statement-breakpoint
CREATE TYPE "public"."orientation" AS ENUM('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW');--> statement-breakpoint
CREATE TYPE "public"."price_list_extractor" AS ENUM('AI', 'HUMAN');--> statement-breakpoint
CREATE TYPE "public"."unit_status" AS ENUM('AVAILABLE', 'RESERVED', 'SOLD');--> statement-breakpoint
CREATE TABLE "development_access" (
	"development_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"allowed_agency_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_access_development_id_allowed_agency_id_pk" PRIMARY KEY("development_id","allowed_agency_id"),
	CONSTRAINT "development_access_not_owner_ck" CHECK ("development_access"."allowed_agency_id" <> "development_access"."agency_id")
);
--> statement-breakpoint
CREATE TABLE "development_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"development_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"kind" "development_document_kind" DEFAULT 'OTHER' NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"storage_key" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_documents_id_agency_uq" UNIQUE("id","agency_id"),
	CONSTRAINT "development_documents_sha256_ck" CHECK ("development_documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "development_documents_type_ck" CHECK ("development_documents"."content_type" = 'application/pdf'),
	CONSTRAINT "development_documents_size_ck" CHECK ("development_documents"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "development_phases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"development_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort" smallint DEFAULT 0 NOT NULL,
	"status" "development_status" DEFAULT 'OFF_PLAN' NOT NULL,
	"completion_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_phases_id_development_uq" UNIQUE("id","development_id","agency_id"),
	CONSTRAINT "development_phases_name_ck" CHECK (char_length("development_phases"."name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "development_translations" (
	"development_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"payment_terms" text,
	"slug" text NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"origin" "translation_origin" DEFAULT 'HUMAN' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_translations_development_id_locale_pk" PRIMARY KEY("development_id","locale"),
	CONSTRAINT "development_translations_locale_ck" CHECK ("development_translations"."locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
	CONSTRAINT "development_translations_slug_ck" CHECK ("development_translations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "developments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"status" "development_status" DEFAULT 'OFF_PLAN' NOT NULL,
	"completion_date" date,
	"location_id" uuid NOT NULL,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"commission_bp" integer,
	"commission_fixed_cents" bigint,
	"commission_includes_vat" boolean DEFAULT false NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"managed_by" "development_manager" DEFAULT 'DEVELOPER' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"access" "development_access_kind" DEFAULT 'PRIVATE_NETWORK' NOT NULL,
	"legacy_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "developments_id_agency_uq" UNIQUE("id","agency_id"),
	CONSTRAINT "developments_currency_ck" CHECK ("developments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "developments_commission_ck" CHECK (("developments"."commission_bp" is null or "developments"."commission_bp" between 1 and 10000)
        and ("developments"."commission_fixed_cents" is null or "developments"."commission_fixed_cents" between 1 and 100000000000)
        and not ("developments"."commission_bp" is not null and "developments"."commission_fixed_cents" is not null)),
	CONSTRAINT "developments_coordinates_ck" CHECK (("developments"."lat" is null) = ("developments"."lng" is null)
        and ("developments"."lat" is null or ("developments"."lat" between -90 and 90 and "developments"."lng" between -180 and 180))),
	CONSTRAINT "developments_version_ck" CHECK ("developments"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"development_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"source_document_id" uuid,
	"extracted_by" "price_list_extractor" DEFAULT 'HUMAN' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"diff_summary" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_lists_id_agency_uq" UNIQUE("id","agency_id"),
	CONSTRAINT "price_lists_version_ck" CHECK ("price_lists"."version" >= 1),
	CONSTRAINT "price_lists_review_ck" CHECK (("price_lists"."reviewed_by_user_id" is null) = ("price_lists"."reviewed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "unit_price_histories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"unit_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"price_list_id" uuid,
	"previous_price_cents" bigint,
	"price_cents" bigint,
	"currency" char(3) NOT NULL,
	"changed_by_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_price_histories_currency_ck" CHECK ("unit_price_histories"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"development_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"phase_id" uuid,
	"ref" text NOT NULL,
	"property_type_id" uuid NOT NULL,
	"bedrooms" integer,
	"bathrooms" integer,
	"internal_m2" numeric(10, 2),
	"terrace_m2" numeric(10, 2),
	"plot_m2" numeric(10, 2),
	"floor" smallint,
	"orientation" "orientation",
	"price_cents" bigint,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"status" "unit_status" DEFAULT 'AVAILABLE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_id_agency_uq" UNIQUE("id","agency_id"),
	CONSTRAINT "units_currency_ck" CHECK ("units"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "units_price_ck" CHECK ("units"."price_cents" is null or "units"."price_cents" >= 0),
	CONSTRAINT "units_specs_ck" CHECK (("units"."bedrooms" is null or "units"."bedrooms" between 0 and 1000)
        and ("units"."bathrooms" is null or "units"."bathrooms" between 0 and 1000)
        and ("units"."internal_m2" is null or "units"."internal_m2" >= 0)
        and ("units"."terrace_m2" is null or "units"."terrace_m2" >= 0)
        and ("units"."plot_m2" is null or "units"."plot_m2" >= 0)
        and ("units"."floor" is null or "units"."floor" between -10 and 300)),
	CONSTRAINT "units_version_ck" CHECK ("units"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "development_access" ADD CONSTRAINT "development_access_allowed_agency_id_agencies_agency_id_fk" FOREIGN KEY ("allowed_agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_access" ADD CONSTRAINT "development_access_development_fk" FOREIGN KEY ("development_id","agency_id") REFERENCES "public"."developments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_documents" ADD CONSTRAINT "development_documents_development_fk" FOREIGN KEY ("development_id","agency_id") REFERENCES "public"."developments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_phases" ADD CONSTRAINT "development_phases_development_fk" FOREIGN KEY ("development_id","agency_id") REFERENCES "public"."developments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_translations" ADD CONSTRAINT "development_translations_development_fk" FOREIGN KEY ("development_id","agency_id") REFERENCES "public"."developments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developments" ADD CONSTRAINT "developments_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developments" ADD CONSTRAINT "developments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_development_fk" FOREIGN KEY ("development_id","agency_id") REFERENCES "public"."developments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_source_document_fk" FOREIGN KEY ("source_document_id","agency_id") REFERENCES "public"."development_documents"("id","agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_price_histories" ADD CONSTRAINT "unit_price_histories_unit_fk" FOREIGN KEY ("unit_id","agency_id") REFERENCES "public"."units"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_price_histories" ADD CONSTRAINT "unit_price_histories_price_list_fk" FOREIGN KEY ("price_list_id","agency_id") REFERENCES "public"."price_lists"("id","agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_property_type_id_property_types_id_fk" FOREIGN KEY ("property_type_id") REFERENCES "public"."property_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_development_fk" FOREIGN KEY ("development_id","agency_id") REFERENCES "public"."developments"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_phase_fk" FOREIGN KEY ("phase_id","development_id","agency_id") REFERENCES "public"."development_phases"("id","development_id","agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "development_access_allowed_idx" ON "development_access" USING btree ("allowed_agency_id");--> statement-breakpoint
CREATE INDEX "development_documents_development_idx" ON "development_documents" USING btree ("development_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "development_documents_key_uq" ON "development_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "development_phases_development_idx" ON "development_phases" USING btree ("development_id","sort","id");--> statement-breakpoint
CREATE UNIQUE INDEX "developments_agency_ref_uq" ON "developments" USING btree ("agency_id","ref");--> statement-breakpoint
CREATE INDEX "developments_agency_created_idx" ON "developments" USING btree ("agency_id",date_trunc('milliseconds', "created_at", 'UTC'),"id");--> statement-breakpoint
CREATE INDEX "developments_location_idx" ON "developments" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "developments_agency_legacy_idx" ON "developments" USING btree ("agency_id","legacy_id") WHERE "developments"."legacy_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_development_version_uq" ON "price_lists" USING btree ("development_id","version");--> statement-breakpoint
CREATE INDEX "price_lists_source_document_idx" ON "price_lists" USING btree ("source_document_id") WHERE "price_lists"."source_document_id" is not null;--> statement-breakpoint
CREATE INDEX "unit_price_histories_unit_idx" ON "unit_price_histories" USING btree ("unit_id","changed_at","id");--> statement-breakpoint
CREATE INDEX "unit_price_histories_price_list_idx" ON "unit_price_histories" USING btree ("price_list_id") WHERE "unit_price_histories"."price_list_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "units_development_ref_uq" ON "units" USING btree ("development_id","ref");--> statement-breakpoint
CREATE INDEX "units_phase_idx" ON "units" USING btree ("phase_id") WHERE "units"."phase_id" is not null;--> statement-breakpoint
CREATE INDEX "units_property_type_idx" ON "units" USING btree ("property_type_id");