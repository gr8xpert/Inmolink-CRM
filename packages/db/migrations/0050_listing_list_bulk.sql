CREATE TYPE "public"."listing_bulk_action_type" AS ENUM('STATUS', 'VISIBILITY', 'SHARE_SCOPE', 'PRICE_CHANGE', 'ASSIGN', 'ADD_TAG');--> statement-breakpoint
CREATE TYPE "public"."listing_bulk_state" AS ENUM('QUEUED', 'RUNNING', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TABLE "listing_bulk_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"type" "listing_bulk_action_type" NOT NULL,
	"params" jsonb NOT NULL,
	"listing_ids" uuid[] NOT NULL,
	"state" "listing_bulk_state" DEFAULT 'QUEUED' NOT NULL,
	"total" integer NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "listing_bulk_actions_counts_ck" CHECK ("listing_bulk_actions"."total" = cardinality("listing_bulk_actions"."listing_ids") and "listing_bulk_actions"."processed" between 0 and "listing_bulk_actions"."total"
        and "listing_bulk_actions"."succeeded" + "listing_bulk_actions"."unchanged" + "listing_bulk_actions"."failed" = "listing_bulk_actions"."processed")
);
--> statement-breakpoint
CREATE TABLE "listing_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"query" jsonb NOT NULL,
	"columns" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_views_name_ck" CHECK (char_length("listing_views"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "property_tags" (
	"property_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_tags_property_id_tag_pk" PRIMARY KEY("property_id","tag"),
	CONSTRAINT "property_tags_tag_ck" CHECK (char_length("property_tags"."tag") between 1 and 40 and "property_tags"."tag" = lower(btrim("property_tags"."tag")))
);
--> statement-breakpoint
ALTER TABLE "listing_bulk_actions" ADD CONSTRAINT "listing_bulk_actions_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_views" ADD CONSTRAINT "listing_views_member_fk" FOREIGN KEY ("agency_id","user_id") REFERENCES "public"."agency_members"("agency_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_tags" ADD CONSTRAINT "property_tags_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_bulk_actions_agency_created_idx" ON "listing_bulk_actions" USING btree ("agency_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_views_member_name_uq" ON "listing_views" USING btree ("agency_id","user_id","name");--> statement-breakpoint
CREATE INDEX "property_tags_agency_tag_idx" ON "property_tags" USING btree ("agency_id","tag","property_id");--> statement-breakpoint
CREATE INDEX "properties_agency_updated_idx" ON "properties" USING btree ("agency_id",date_trunc('milliseconds', "updated_at", 'UTC'),"id");--> statement-breakpoint
CREATE INDEX "properties_agency_price_idx" ON "properties" USING btree ("agency_id","price_cents","id");