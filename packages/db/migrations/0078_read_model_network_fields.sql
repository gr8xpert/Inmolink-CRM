ALTER TABLE "listing_read_models" ADD COLUMN "network_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_read_models" ADD COLUMN "preferred_agency_ids" uuid[];