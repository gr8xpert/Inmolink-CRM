ALTER TABLE "properties" ADD COLUMN "price_to_cents" bigint;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "community_fee_month_cents" bigint;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "ibi_year_cents" bigint;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "garbage_tax_year_cents" bigint;--> statement-breakpoint
ALTER TABLE "property_import_staging" ADD COLUMN "price_to_cents" bigint;--> statement-breakpoint
ALTER TABLE "property_import_staging" ADD COLUMN "community_fee_month_cents" bigint;--> statement-breakpoint
ALTER TABLE "property_import_staging" ADD COLUMN "ibi_year_cents" bigint;--> statement-breakpoint
ALTER TABLE "property_import_staging" ADD COLUMN "garbage_tax_year_cents" bigint;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_costs_ck" CHECK (("properties"."price_to_cents" is null or "properties"."price_to_cents" >= 0)
        and ("properties"."community_fee_month_cents" is null or "properties"."community_fee_month_cents" >= 0)
        and ("properties"."ibi_year_cents" is null or "properties"."ibi_year_cents" >= 0)
        and ("properties"."garbage_tax_year_cents" is null or "properties"."garbage_tax_year_cents" >= 0)) NOT VALID;