ALTER TABLE "unit_price_histories" DROP CONSTRAINT "unit_price_histories_price_list_fk";
--> statement-breakpoint
ALTER TABLE "unit_status_histories" DROP CONSTRAINT "unit_status_histories_price_list_fk";
--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "currency" char(3) DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_price_histories" ADD CONSTRAINT "unit_price_histories_price_list_fk" FOREIGN KEY ("price_list_id","agency_id") REFERENCES "public"."price_lists"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_status_histories" ADD CONSTRAINT "unit_status_histories_price_list_fk" FOREIGN KEY ("price_list_id","agency_id") REFERENCES "public"."price_lists"("id","agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_currency_ck" CHECK ("agency_settings"."currency" ~ '^[A-Z]{3}$');