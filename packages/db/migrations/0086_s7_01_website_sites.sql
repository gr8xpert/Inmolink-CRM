CREATE TYPE "public"."inventory_policy" AS ENUM('OWN_ONLY', 'OWN_PLUS_NETWORK', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."website_mode" AS ENUM('WP_PLUGIN', 'WIDGET', 'HOSTED');--> statement-breakpoint
CREATE TABLE "website_sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"mode" "website_mode" NOT NULL,
	"inventory_policy" "inventory_policy" DEFAULT 'OWN_ONLY' NOT NULL,
	"inventory_filters" jsonb,
	"reference_prefix" text,
	"locales" text[] NOT NULL,
	"default_locale" text NOT NULL,
	"contact" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_sites_prefix_ck" CHECK ("website_sites"."reference_prefix" is null or "website_sites"."reference_prefix" ~ '^[A-Z0-9]{1,6}$'),
	CONSTRAINT "website_sites_filters_ck" CHECK (("website_sites"."inventory_policy" = 'CUSTOM') = ("website_sites"."inventory_filters" is not null)),
	CONSTRAINT "website_sites_locales_ck" CHECK (cardinality("website_sites"."locales") between 1 and 20 and "website_sites"."default_locale" = "website_sites"."locales"[1])
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "site_id" uuid;--> statement-breakpoint
ALTER TABLE "listing_search_docs" ADD COLUMN "share_scope" text;--> statement-breakpoint
ALTER TABLE "listing_search_docs" ADD COLUMN "preferred_agency_ids" uuid[];--> statement-breakpoint
ALTER TABLE "listing_search_docs" ADD COLUMN "network_hidden" boolean;--> statement-breakpoint
ALTER TABLE "website_sites" ADD CONSTRAINT "website_sites_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_sites_agency_created_idx" ON "website_sites" USING btree ("agency_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "website_sites_agency_id_uq" ON "website_sites" USING btree ("agency_id","id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_site_fk" FOREIGN KEY ("agency_id","site_id") REFERENCES "public"."website_sites"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_site_idx" ON "api_keys" USING btree ("site_id");