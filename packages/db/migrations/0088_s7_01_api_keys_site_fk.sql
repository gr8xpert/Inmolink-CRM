ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_site_fk";
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_site_fk" FOREIGN KEY ("agency_id","site_id") REFERENCES "public"."website_sites"("agency_id","id") ON DELETE no action ON UPDATE no action;