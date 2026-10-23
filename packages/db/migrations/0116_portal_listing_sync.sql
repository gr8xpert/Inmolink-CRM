CREATE TYPE "public"."portal_sync_state" AS ENUM('SYNCED', 'FAILED', 'WITHDRAWN');--> statement-breakpoint
CREATE TABLE "portal_listing_sync" (
	"connection_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"state" "portal_sync_state" NOT NULL,
	"remote_id" text,
	"payload_hash" text NOT NULL,
	"error_code" text,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portal_listing_sync_connection_id_property_id_pk" PRIMARY KEY("connection_id","property_id"),
	CONSTRAINT "portal_listing_sync_error_ck" CHECK ("portal_listing_sync"."error_code" is null or char_length("portal_listing_sync"."error_code") <= 40)
);
--> statement-breakpoint
ALTER TABLE "portal_listing_sync" ADD CONSTRAINT "portal_listing_sync_connection_fk" FOREIGN KEY ("agency_id","connection_id") REFERENCES "public"."agency_portal_connections"("agency_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_listing_sync" ADD CONSTRAINT "portal_listing_sync_property_fk" FOREIGN KEY ("property_id","agency_id") REFERENCES "public"."properties"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_listing_sync_property_idx" ON "portal_listing_sync" USING btree ("property_id");