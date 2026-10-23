CREATE TYPE "public"."portal_feed_run_status" AS ENUM('WRITTEN', 'UNCHANGED', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."portal_feed_run_trigger" AS ENUM('EVENT', 'NIGHTLY');--> statement-breakpoint
CREATE TABLE "portal_feed_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" "portal_feed_run_trigger" NOT NULL,
	"status" "portal_feed_run_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"valid_count" integer,
	"invalid_count" integer,
	"bytes" integer,
	"sha256" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_feed_runs_reason_ck" CHECK ("portal_feed_runs"."reason" is null or char_length("portal_feed_runs"."reason") <= 40)
);
--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "feed_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "feed_sha256" text;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "feed_bytes" integer;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "feed_item_count" integer;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "feed_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agency_portal_connections" ADD COLUMN "nightly_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portal_feed_runs" ADD CONSTRAINT "portal_feed_runs_connection_fk" FOREIGN KEY ("agency_id","connection_id") REFERENCES "public"."agency_portal_connections"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_feed_runs_connection_idx" ON "portal_feed_runs" USING btree ("agency_id","connection_id","id");--> statement-breakpoint
CREATE INDEX "agency_portal_connections_live_idx" ON "agency_portal_connections" USING btree ("agency_id","nightly_at") WHERE "agency_portal_connections"."enabled" and "agency_portal_connections"."revoked_at" is null;