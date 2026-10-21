CREATE TABLE "website_feeds" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"token_created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"run_id" uuid,
	"generated_at" timestamp with time zone,
	"item_count" integer,
	"kyero_count" integer,
	"kyero_sha256" text,
	"generic_sha256" text,
	"last_error" text,
	"failed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_feeds_hint_ck" CHECK (length("website_feeds"."token_hint") = 4),
	CONSTRAINT "website_feeds_error_ck" CHECK ("website_feeds"."last_error" is null or length("website_feeds"."last_error") <= 64)
);
--> statement-breakpoint
ALTER TABLE "website_feeds" ADD CONSTRAINT "website_feeds_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_feeds" ADD CONSTRAINT "website_feeds_site_fk" FOREIGN KEY ("agency_id","site_id") REFERENCES "public"."website_sites"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "website_feeds_token_uq" ON "website_feeds" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "website_feeds_agency_idx" ON "website_feeds" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "website_feeds_refresh_idx" ON "website_feeds" USING btree ("generated_at") WHERE "website_feeds"."revoked_at" is null;